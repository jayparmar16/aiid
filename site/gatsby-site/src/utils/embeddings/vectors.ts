/** Backend-only schema-v2 vector loading and ranking, reused from feature-rag-search. */
import { Binary, type MongoClient } from 'mongodb';
import {
  EMBEDDINGS_COLLECTION,
  getEmbeddingIndexFilter,
  type EmbeddingIndexConfig,
} from './config';

const CACHE_TTL_MS = 10 * 60 * 1000;
const MIN_SCORE = 0.15;
const OVERVIEW_WEIGHT = 0.65;
const PASSAGE_WEIGHT = 0.35;

/** Overview and passage vectors are normalized once, when the corpus is loaded. */
export interface IncidentVectors {
  incidentId: number;
  overview: Float32Array;
  passages: Float32Array[];
}

const normalise = (vector: Float32Array): Float32Array | null => {
  let magnitudeSquared = 0;
  for (const component of vector) {
    if (!Number.isFinite(component)) return null;
    magnitudeSquared += component * component;
  }
  const magnitude = Math.sqrt(magnitudeSquared);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  for (let index = 0; index < vector.length; index++) vector[index] /= magnitude;
  return vector;
};

/** Decoding returns a copy; normalizing it does not change the stored BSON value. */
export const normaliseBinaryVector = (value: unknown, dimensions: number): Float32Array | null => {
  if (!(value instanceof Binary)) return null;
  try {
    const vector = value.toFloat32Array();
    return vector.length === dimensions ? normalise(vector) : null;
  } catch {
    return null;
  }
};

const dot = (left: Float32Array, right: Float32Array): number => {
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
};

/** Readers share validation and normalization, whether dimensions come from a query or a row. */
export const decodeIncidentVectors = (
  document: {
    [key: string]: unknown;
    incident_id?: unknown;
    dims?: unknown;
    overview?: any;
    passages?: any;
  },
  dimensions: unknown = document.dims
): IncidentVectors | null => {
  if (
    typeof document.incident_id !== 'number' ||
    !Number.isSafeInteger(document.incident_id) ||
    document.incident_id <= 0 ||
    typeof dimensions !== 'number' ||
    !Number.isSafeInteger(dimensions) ||
    dimensions <= 0
  )
    return null;
  const overview = normaliseBinaryVector(document.overview?.vector, dimensions);
  if (!overview) return null;
  const passages = Array.isArray(document.passages)
    ? document.passages
        .map((passage: any) => normaliseBinaryVector(passage?.vector, dimensions))
        .filter((vector: Float32Array | null): vector is Float32Array => vector !== null)
    : [];
  return { incidentId: document.incident_id, overview, passages };
};

/** Weighted overview and best-passage cosine similarity; absent passages use the overview. */
export const rankIncidentVectors = (
  incidents: readonly IncidentVectors[],
  query: readonly number[],
  limit: number,
  minimumScore = MIN_SCORE
): { incident_id: number; score: number }[] => {
  const normalisedQuery = normalise(Float32Array.from(query));
  if (!normalisedQuery) return [];

  const hits: { incident_id: number; score: number }[] = [];
  for (const incident of incidents) {
    if (incident.overview.length !== normalisedQuery.length) continue;
    const overviewScore = dot(incident.overview, normalisedQuery);
    let passageScore = overviewScore;
    let foundPassage = false;
    for (const passage of incident.passages) {
      if (passage.length !== normalisedQuery.length) continue;
      const candidate = dot(passage, normalisedQuery);
      passageScore = foundPassage ? Math.max(passageScore, candidate) : candidate;
      foundPassage = true;
    }
    const score = OVERVIEW_WEIGHT * overviewScore + PASSAGE_WEIGHT * passageScore;
    if (score >= minimumScore) hits.push({ incident_id: incident.incidentId, score });
  }
  return hits
    .sort((left, right) => right.score - left.score || left.incident_id - right.incident_id)
    .slice(0, Math.max(0, limit));
};

interface VectorCache {
  key: string;
  incidents: IncidentVectors[];
  loadedAt: number;
}

/** A loader owns its cache; clients/databases and all embedding configurations remain isolated. */
export const createIncidentVectorLoader = () => {
  let cache = new WeakMap<MongoClient, VectorCache>();

  const load = async (
    client: MongoClient,
    index: EmbeddingIndexConfig,
    dimensions: number,
    databaseName = 'aiidprod',
    signal?: AbortSignal
  ): Promise<IncidentVectors[]> => {
    signal?.throwIfAborted();
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error('dimensions must be a positive integer');
    }
    const filter = getEmbeddingIndexFilter(index, dimensions);
    const key = JSON.stringify({ databaseName, ...filter });
    const cached = cache.get(client);
    if (cached?.key === key && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
      return cached.incidents;
    }

    const cursor = client
      .db(databaseName)
      .collection(EMBEDDINGS_COLLECTION)
      .find(filter, {
        projection: { _id: 0, incident_id: 1, 'overview.vector': 1, 'passages.vector': 1 },
        signal,
      })
      .sort({ incident_id: 1 });
    const incidents: IncidentVectors[] = [];
    try {
      for await (const document of cursor) {
        const incident = decodeIncidentVectors(document, dimensions);
        if (incident) incidents.push(incident);
      }
    } finally {
      await cursor.close();
    }
    // Do not hide an initial backfill behind an empty warm-function cache.
    if (incidents.length > 0) cache.set(client, { key, incidents, loadedAt: Date.now() });
    return incidents;
  };

  return {
    load,
    clear: () => {
      cache = new WeakMap();
    },
  };
};
