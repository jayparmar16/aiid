/** Derive persisted, directed incident neighbors without any provider calls. */
import { type AnyBulkWriteOperation, type Document, type MongoClient } from 'mongodb';
import {
  EMBEDDINGS_COLLECTION,
  getConfiguredEmbeddingIndex,
  getEmbeddingIndexFilter,
  type EmbeddingIndexConfig,
} from './config';
import { decodeIncidentVectors, rankIncidentVectors, type IncidentVectors } from './vectors';

export interface NeighborRefreshOptions {
  incidentIds?: number[];
  limit?: number;
  num?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface NeighborRefreshSummary {
  targets: number;
  corpus: number;
  skipped: number;
  unchanged: number;
  changed: number;
  written: number;
  dryRun: boolean;
}

const positiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
};

/** An overview is compared to candidate overview/best-passage vectors using the shared weights. */
export const deriveIncidentNeighbors = (
  corpus: readonly IncidentVectors[],
  source: IncidentVectors,
  num = 3
) => {
  positiveInteger(num, 'num');
  return rankIncidentVectors(corpus, Array.from(source.overview), Infinity)
    .filter((hit) => hit.incident_id !== source.incidentId)
    .slice(0, num)
    .map(({ incident_id, score }) => ({ incident_id, similarity: score }));
};

/** Only nlp_similar_incidents is written. Unbackfilled incidents and human decisions are retained. */
export const refreshIncidentNeighbors = async (
  client: MongoClient,
  options: NeighborRefreshOptions = {},
  index: EmbeddingIndexConfig = getConfiguredEmbeddingIndex(),
  databaseName = 'aiidprod'
): Promise<NeighborRefreshSummary> => {
  const num = options.num ?? 3;
  positiveInteger(num, 'num');
  if (options.limit !== undefined) positiveInteger(options.limit, 'limit');
  for (const id of options.incidentIds ?? []) positiveInteger(id, 'incident-id');
  const signal = options.signal;
  signal?.throwIfAborted();
  const db = client.db(databaseName);
  const collection = db.collection('incidents');
  const incidents = await collection
    .find(
      {},
      {
        projection: { _id: 0, incident_id: 1, nlp_similar_incidents: 1 },
        signal,
      }
    )
    .sort({ incident_id: 1 })
    .toArray();
  const current = incidents.filter(
    (incident) => Number.isSafeInteger(incident.incident_id) && incident.incident_id > 0
  );
  const active = new Set(current.map((incident) => incident.incident_id));
  const cursor = db
    .collection(EMBEDDINGS_COLLECTION)
    .find(getEmbeddingIndexFilter(index), {
      projection: { _id: 0, incident_id: 1, dims: 1, 'overview.vector': 1, 'passages.vector': 1 },
      signal,
    })
    .sort({ incident_id: 1 });
  const corpus: IncidentVectors[] = [];
  try {
    for await (const document of cursor) {
      signal?.throwIfAborted();
      if (!active.has(document.incident_id)) continue;
      const incident = decodeIncidentVectors(document);
      if (incident) corpus.push(incident);
    }
  } finally {
    await cursor.close();
  }
  if (new Set(corpus.map((incident) => incident.overview.length)).size > 1)
    throw new Error('Compatible neighbor embeddings have mixed dimensions');
  if (current.length > 0 && corpus.length === 0)
    throw new Error('No compatible incident embeddings; existing neighbor lists were not changed');

  const targets = current
    .filter(
      (incident) =>
        !options.incidentIds?.length || options.incidentIds.includes(incident.incident_id)
    )
    .slice(0, options.limit ?? Infinity);
  const byId = new Map(corpus.map((incident) => [incident.incidentId, incident]));
  const summary: NeighborRefreshSummary = {
    targets: targets.length,
    corpus: corpus.length,
    skipped: 0,
    unchanged: 0,
    changed: 0,
    written: 0,
    dryRun: options.dryRun ?? false,
  };
  let writes: AnyBulkWriteOperation<Document>[] = [];
  const flush = async () => {
    if (writes.length === 0) return;
    signal?.throwIfAborted();
    if (!summary.dryRun) {
      const result = await collection.bulkWrite(writes);
      summary.written += result.modifiedCount;
    }
    writes = [];
  };
  for (const target of targets) {
    signal?.throwIfAborted();
    const source = byId.get(target.incident_id);
    if (!source) {
      summary.skipped++;
      continue;
    }
    const neighbors = deriveIncidentNeighbors(corpus, source, num);
    if (JSON.stringify(neighbors) === JSON.stringify(target.nlp_similar_incidents)) {
      summary.unchanged++;
    } else {
      summary.changed++;
      writes.push({
        updateOne: {
          filter: { incident_id: target.incident_id },
          update: { $set: { nlp_similar_incidents: neighbors } },
        },
      });
      if (writes.length >= 100) await flush();
    }
    // Permit cancellation between CPU-bound per-incident rankings.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await flush();
  return summary;
};
