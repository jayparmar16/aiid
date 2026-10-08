/** Build-time t-SNE uses overview vectors only, never legacy pooled report embeddings. */
import { Double, MongoClient } from 'mongodb';
import {
  EMBEDDINGS_COLLECTION,
  getConfiguredEmbeddingIndex,
  getEmbeddingIndexFilter,
  type EmbeddingIndexConfig,
} from './config';
import { normaliseBinaryVector } from './vectors';

const TSNE = require('tsne-js');

export interface SpatialIncident {
  incident_id: number;
  tsne: { x: number; y: number };
}

type Project = (vectors: number[][], iterations: number) => number[][];

export const projectOverviewVectors: Project = (vectors, iterations) => {
  // Tiny backfills cannot support the regular perplexity or the library's scaled output.
  if (vectors.length === 0) return [];
  if (vectors.length === 1) return [[0, 0]];
  if (vectors.length === 2)
    return [
      [-1, 0],
      [1, 0],
    ];

  const model = new TSNE({
    dim: 2,
    perplexity: Math.min(30, vectors.length - 1),
    earlyExaggeration: 3,
    learningRate: 100,
    nIter: iterations,
    metric: 'euclidean',
  });
  model.init({ data: vectors, type: 'dense' });
  model.run();
  return model.getOutputScaled();
};

/** The caller owns this client. All coordinate writes finish before this function returns. */
export const updateTsneWithClient = async (
  client: MongoClient,
  index: EmbeddingIndexConfig = getConfiguredEmbeddingIndex(),
  databaseName = 'aiidprod',
  project: Project = projectOverviewVectors
): Promise<SpatialIncident[]> => {
  const iterations = Number(process.env.TSNE_NITER ?? 1000);
  if (!Number.isSafeInteger(iterations) || iterations <= 0)
    throw new Error('TSNE_NITER must be a positive integer');

  const db = client.db(databaseName);
  const collection = db.collection('incidents');
  const documents = await db
    .collection(EMBEDDINGS_COLLECTION)
    .find(getEmbeddingIndexFilter(index), {
      projection: { _id: 0, incident_id: 1, dims: 1, 'overview.vector': 1 },
    })
    .sort({ incident_id: 1 })
    .toArray();
  const ids = documents
    .map((document) => document.incident_id)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return [];
  const current = await collection
    .find({ incident_id: { $in: ids } }, { projection: { _id: 0, incident_id: 1 } })
    .toArray();
  const active = new Set(current.map((incident) => incident.incident_id));
  const inputs: { incidentId: number; vector: number[] }[] = [];
  const dimensions = new Set<number>();
  for (const document of documents) {
    if (
      !active.has(document.incident_id) ||
      !Number.isSafeInteger(document.dims) ||
      document.dims <= 0
    )
      continue;
    const vector = normaliseBinaryVector(document.overview?.vector, document.dims);
    if (!vector) continue;
    dimensions.add(vector.length);
    inputs.push({ incidentId: document.incident_id, vector: Array.from(vector) });
  }
  if (dimensions.size > 1) throw new Error('Compatible spatial embeddings have mixed dimensions');
  if (inputs.length === 0) return [];

  const output = project(
    inputs.map((input) => input.vector),
    iterations
  );
  if (
    output.length !== inputs.length ||
    output.some(
      (point) =>
        !Array.isArray(point) ||
        point.length !== 2 ||
        point.some((coordinate) => !Number.isFinite(coordinate) || Math.abs(coordinate) > 1)
    )
  ) {
    throw new Error('t-SNE returned invalid spatial coordinates');
  }
  const positions = inputs.map(({ incidentId }, position) => ({
    incident_id: incidentId,
    tsne: { x: output[position][0], y: output[position][1] },
  }));
  await collection.bulkWrite(
    positions.map(({ incident_id, tsne }) => ({
      updateOne: {
        filter: { incident_id },
        update: { $set: { tsne: { x: new Double(tsne.x), y: new Double(tsne.y) } } },
      },
    }))
  );
  return positions;
};

/** Build wrapper owns and closes its MongoDB connection on success and failure. */
export const updateTsneInDatabase = async (
  connectionString: string,
  databaseName = 'aiidprod'
): Promise<SpatialIncident[]> => {
  if (!connectionString)
    throw new Error('MONGODB_CONNECTION_STRING is required for the spatial build');
  const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    return await updateTsneWithClient(client, getConfiguredEmbeddingIndex(), databaseName);
  } finally {
    await client.close();
  }
};
