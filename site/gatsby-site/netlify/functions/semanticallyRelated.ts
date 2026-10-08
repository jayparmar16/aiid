import { withSentry } from '../../sentry-instrumentation';
import * as Sentry from '@sentry/aws-serverless';
import type { HandlerEvent, HandlerResponse } from '@netlify/functions';
import { MongoClient } from 'mongodb';
import {
  createEmbeddingProvider,
  EmbeddingRequestError,
} from '../../src/utils/embeddings/provider';
import { getEmbeddingIndexConfig } from '../../src/utils/embeddings/config';
import { chunkTextWithOffsets } from '../../src/utils/embeddings/incidentText';
import {
  createIncidentVectorLoader,
  rankIncidentVectors,
} from '../../src/utils/embeddings/vectors';

const REQUEST_TIMEOUT_MS = 60_000;
const EMBED_TIMEOUT_MS = 8000;

type RequestEvent = Pick<HandlerEvent, 'body' | 'httpMethod' | 'isBase64Encoded'>;
const response = (statusCode: number, body: unknown): HandlerResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Each warm function owns its corpus cache; injection keeps endpoint tests entirely local. */
export const createSemanticallyRelatedHandler = (getClient: () => MongoClient) => {
  const loader = createIncidentVectorLoader();

  return async (event: RequestEvent): Promise<HandlerResponse> => {
    if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

    let text: string;
    let limit: number;
    let excludeIncidentId: number | undefined;
    let includeSimilar: boolean;
    try {
      const body = JSON.parse(
        event.isBase64Encoded
          ? Buffer.from(event.body || '', 'base64').toString('utf8')
          : event.body || ''
      );
      if (!body || typeof body.text !== 'string' || !body.text.trim())
        throw new Error('Text is required');
      text = body.text.trim();
      const num = body.num == null || body.num === 0 ? 3 : body.num;
      if (
        !['number', 'string'].includes(typeof num) ||
        String(num).trim() === '' ||
        !Number.isSafeInteger(Number(num))
      ) {
        throw new Error('num must be an integer');
      }
      limit = Number(num) < 0 ? Infinity : Number(num) || 3;
      if (body.excludeIncidentId != null) {
        if (
          !['number', 'string'].includes(typeof body.excludeIncidentId) ||
          !Number.isSafeInteger(Number(body.excludeIncidentId)) ||
          Number(body.excludeIncidentId) <= 0
        ) {
          throw new Error('excludeIncidentId must be a positive integer');
        }
        excludeIncidentId = Number(body.excludeIncidentId);
      }
      if (body.includeSimilar != null && typeof body.includeSimilar !== 'boolean') {
        throw new Error('includeSimilar must be a boolean');
      }
      includeSimilar = body.includeSimilar ?? true;
      // max_retries is accepted for compatibility; interactive embeddings use one attempt.
    } catch (error) {
      return response(400, {
        error: error instanceof SyntaxError ? 'Invalid JSON body' : (error as Error).message,
      });
    }

    if (!includeSimilar) return response(200, { embedding: null, incidents: [] });

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const search = async () => {
        const provider = createEmbeddingProvider({
          maxAttempts: 1,
          timeoutMs: EMBED_TIMEOUT_MS,
          signal: controller.signal,
        });
        const index = getEmbeddingIndexConfig(provider);
        const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE || 32);
        if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
          throw new Error('Invalid embedding batch size');
        const chunks = chunkTextWithOffsets(text, index.maxInputChars, index.overlapChars);
        const client = getClient();
        let corpus: Awaited<ReturnType<typeof loader.load>> | undefined;
        let dimensions: number | undefined;
        const scores = new Map<number, number>();

        for (let offset = 0; offset < chunks.length; offset += batchSize) {
          controller.signal.throwIfAborted();
          const { vectors } = await provider.embed(
            chunks.slice(offset, offset + batchSize).map((chunk) => chunk.text),
            'query'
          );
          dimensions ??= vectors[0].length;
          if (vectors.some((vector) => vector.length !== dimensions))
            throw new Error('Inconsistent query dimensions');
          corpus ??= await loader.load(client, index, dimensions, 'aiidprod', controller.signal);
          if (corpus.length === 0) throw new Error('No compatible incident embeddings');
          for (const vector of vectors) {
            for (const hit of rankIncidentVectors(corpus, vector, Infinity)) {
              if (hit.incident_id !== excludeIncidentId) {
                scores.set(
                  hit.incident_id,
                  Math.max(scores.get(hit.incident_id) ?? -Infinity, hit.score)
                );
              }
            }
          }
        }

        if (scores.size === 0) return [];
        // The vector cache may still contain an incident deleted since its last load.
        const current = await client
          .db('aiidprod')
          .collection('incidents')
          .find(
            { incident_id: { $in: [...scores.keys()] } },
            { projection: { _id: 0, incident_id: 1 }, signal: controller.signal }
          )
          .toArray();
        const active = new Set(current.map((incident) => incident.incident_id));
        return [...scores.entries()]
          .filter(([id]) => active.has(id))
          .sort(
            ([leftId, leftScore], [rightId, rightScore]) =>
              rightScore - leftScore || leftId - rightId
          )
          .slice(0, limit)
          .map(([incident_id, similarity]) => ({ incident_id, similarity }));
      };
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Similarity request timed out'));
        }, REQUEST_TIMEOUT_MS);
      });
      const incidents = await Promise.race([search(), deadline]);
      return response(200, { embedding: null, incidents });
    } catch (error) {
      Sentry.captureException(error);
      const limited =
        error instanceof EmbeddingRequestError && (error.status === 429 || error.quotaExhausted);
      return response(limited ? 429 : 503, {
        error: limited ? 'Similarity quota exhausted' : 'Similarity is unavailable',
      });
    } finally {
      clearTimeout(timer);
    }
  };
};

let client: MongoClient | undefined;
export const handler = withSentry(
  createSemanticallyRelatedHandler(() => {
    const uri = process.env.API_MONGODB_CONNECTION_STRING;
    if (!uri) throw new Error('API_MONGODB_CONNECTION_STRING is required');
    client ??= new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 60000,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    return client;
  })
);
