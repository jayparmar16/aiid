import * as Sentry from '@sentry/aws-serverless';
import { Binary } from 'mongodb';
import {
  GraphQLEnumType,
  GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { allow } from 'graphql-shield';
import {
  createEmbeddingProvider,
  EmbeddingRequestError,
} from '../../src/utils/embeddings/provider';
import { Context, DBIncident } from '../interfaces';
import { IncidentFacts, loadIncidentFacts } from '../semanticSearch/incidentFacts';
import { parseQuery } from '../semanticSearch/parseQuery';
import { IncidentType } from '../types/incidents';

const EMBEDDING_SCHEMA_VERSION = 2;
const MAX_QUERY_CHARS = 500;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MIN_SCORE = 0.15;
const OVERVIEW_WEIGHT = 0.65;
const PASSAGE_WEIGHT = 0.35;
const CACHE_TTL_MS = 10 * 60 * 1000;
const EMBED_TIMEOUT_MS = 8000;

const SemanticSearchStatusType = new GraphQLEnumType({
  name: 'SemanticSearchStatus',
  description: 'Whether the search ran. Every status other than OK has an empty result list.',
  values: {
    OK: { description: 'The search ran, including when nothing matched.' },
    QUOTA_EXHAUSTED: {
      description: 'The embedding provider refused the request because its limit was reached.',
    },
    UNAVAILABLE: { description: 'Search is not configured, or an embedding dependency failed.' },
  },
});

const SemanticSearchResultType = new GraphQLObjectType({
  name: 'SemanticSearchResult',
  fields: {
    score: {
      type: new GraphQLNonNull(GraphQLFloat),
      description: 'Weighted cosine similarity across the incident overview and best passage.',
    },
    incident: { type: new GraphQLNonNull(IncidentType) },
  },
});

const SemanticSearchEntityType = new GraphQLObjectType({
  name: 'SemanticSearchEntity',
  description: 'An entity that a constraint covers.',
  fields: {
    entity_id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    matchedBy: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'SemanticSearchEntityMatch',
          values: {
            NAME: { description: "The entity's whole name was written." },
            FAMILY: {
              description:
                "The entity's name contains what was written, as with a product named after its company.",
            },
          },
        })
      ),
    },
  },
});

const SemanticSearchConstraintType = new GraphQLObjectType({
  name: 'SemanticSearchConstraint',
  description: 'A rule applied to the results before they are ranked by meaning.',
  fields: {
    kind: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'SemanticSearchConstraintKind',
          values: {
            EXCLUDE_ENTITY: {
              description:
                'Removes incidents in which a covered entity is the alleged deployer, developer or implicated system.',
            },
          },
        })
      ),
    },
    source: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'SemanticSearchConstraintSource',
          values: { QUERY_TEXT: { description: 'Read from the query text.' } },
        })
      ),
    },
    matchedText: {
      type: GraphQLString,
      description: 'The words in the query that named what the constraint covers.',
    },
    entities: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SemanticSearchEntityType))),
    },
    incidentCount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'How many incidents in the whole database the constraint applies to.',
    },
  },
});

const SemanticSearchWarningType = new GraphQLObjectType({
  name: 'SemanticSearchWarning',
  fields: {
    code: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'SemanticSearchWarningCode',
          values: {
            UNRECOGNISED_EXCLUSION: {
              description:
                'The words after an exclusion are not a known organisation or system, so nothing was excluded. The words were not searched for either.',
            },
          },
        })
      ),
    },
    text: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The words concerned, as written.',
    },
  },
});

const SemanticSearchInterpretationType = new GraphQLObjectType({
  name: 'SemanticSearchInterpretation',
  description: 'How the query was read.',
  fields: {
    semanticText: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The part of the query ranked by meaning, with constraint phrases removed.',
    },
    constraints: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SemanticSearchConstraintType))),
    },
    warnings: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SemanticSearchWarningType))),
    },
  },
});

const SemanticSearchResponseType = new GraphQLObjectType({
  name: 'SemanticSearchResponse',
  fields: {
    status: { type: new GraphQLNonNull(SemanticSearchStatusType) },
    results: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SemanticSearchResultType))),
    },
    interpretation: {
      type: new GraphQLNonNull(SemanticSearchInterpretationType),
      description: 'Returned with every status, so a caller can show how the query was read.',
    },
  },
});

export interface CachedIncidentVectors {
  incidentId: number;
  overview: Float32Array;
  passages: Float32Array[];
}

const cacheResets: (() => void)[] = [];

/** Clears every warm cache in this module, since each one registers its reset here. */
export const resetSemanticSearchCache = () => {
  for (const reset of cacheResets) reset();
};

/**
 * Keeps one loaded value on a warm function for CACHE_TTL_MS, loading again when the key changes
 * or the value expires. A value that fails `keep` is returned without being cached.
 */
const createWarmCache = <T>(keep: (value: T) => boolean = () => true) => {
  let entry: { key: string; value: T; loadedAt: number } | null = null;

  cacheResets.push(() => {
    entry = null;
  });

  return async (key: string, load: () => Promise<T>): Promise<T> => {
    if (entry?.key === key && Date.now() - entry.loadedAt < CACHE_TTL_MS) return entry.value;

    const value = await load();
    if (keep(value)) entry = { key, value, loadedAt: Date.now() };

    return value;
  };
};

// An empty load is not kept, so vectors written after it are found by the next search.
const cachedVectors = createWarmCache<CachedIncidentVectors[]>((incidents) => incidents.length > 0);

// Not keyed by the embedding model: the query is parsed before anything is embedded.
const cachedFacts = createWarmCache<IncidentFacts>();
const FACTS_CACHE_KEY = 'incident-facts';

/** Converts BSON Float32 vector data to a unit vector, rejecting malformed values. */
export const normaliseBinaryVector = (value: unknown, dimensions: number): Float32Array | null => {
  if (!(value instanceof Binary)) return null;

  let vector: Float32Array;

  try {
    vector = value.toFloat32Array();
  } catch {
    return null;
  }

  if (vector.length !== dimensions) return null;

  let magnitudeSquared = 0;

  for (const component of vector) {
    if (!Number.isFinite(component)) return null;
    magnitudeSquared += component * component;
  }

  const magnitude = Math.sqrt(magnitudeSquared);
  if (magnitude === 0) return null;

  for (let index = 0; index < vector.length; index++) vector[index] /= magnitude;

  return vector;
};

const normaliseQueryVector = (value: number[]): Float32Array | null => {
  if (value.length === 0 || value.some((component) => !Number.isFinite(component))) return null;

  const vector = Float32Array.from(value);
  let magnitudeSquared = 0;

  for (const component of vector) magnitudeSquared += component * component;

  const magnitude = Math.sqrt(magnitudeSquared);
  if (magnitude === 0) return null;

  for (let index = 0; index < vector.length; index++) vector[index] /= magnitude;

  return vector;
};

const dot = (left: Float32Array, right: Float32Array): number => {
  let score = 0;

  for (let index = 0; index < left.length; index++) score += left[index] * right[index];

  return score;
};

/**
 * Ranks the cached overview and passage vectors without allocating per-vector number arrays.
 * When `allowedIncidentIds` is given, every other incident is skipped before scoring, so the
 * limit is filled from allowed incidents only.
 */
export const rankIncidentVectors = (
  incidents: CachedIncidentVectors[],
  query: number[],
  limit: number,
  minimumScore = MIN_SCORE,
  allowedIncidentIds?: ReadonlySet<number>
): { incident_id: number; score: number }[] => {
  const normalisedQuery = normaliseQueryVector(query);
  if (!normalisedQuery) return [];

  const hits: { incident_id: number; score: number }[] = [];

  for (const incident of incidents) {
    if (allowedIncidentIds && !allowedIncidentIds.has(incident.incidentId)) continue;
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

  return hits.sort((left, right) => right.score - left.score).slice(0, limit);
};

/** Streams schema-v2 BSON vectors into a compact warm-function cache. */
const loadVectors = (
  context: Context,
  model: string,
  profileId: string,
  dimensions: number
): Promise<CachedIncidentVectors[]> =>
  cachedVectors(`${EMBEDDING_SCHEMA_VERSION}:${model}:${profileId}:${dimensions}`, async () => {
    const cursor = context.client
      .db('aiidprod')
      .collection('incident_embeddings')
      .find(
        {
          embedding_schema_version: EMBEDDING_SCHEMA_VERSION,
          embedding_profile: profileId,
          model,
          dims: dimensions,
        },
        {
          projection: {
            _id: 0,
            incident_id: 1,
            'overview.vector': 1,
            'passages.vector': 1,
          },
        }
      )
      .sort({ incident_id: 1 });

    const incidents: CachedIncidentVectors[] = [];

    for await (const document of cursor) {
      const overview = normaliseBinaryVector(document.overview?.vector, dimensions);
      if (!overview) continue;

      const passages = Array.isArray(document.passages)
        ? document.passages
            .map((passage: any) => normaliseBinaryVector(passage?.vector, dimensions))
            .filter((vector): vector is Float32Array => vector !== null)
        : [];

      incidents.push({ incidentId: document.incident_id, overview, passages });
    }

    return incidents;
  });

type Embedded =
  | { model: string; profileId: string; vector: number[] }
  | { status: 'QUOTA_EXHAUSTED' | 'UNAVAILABLE' };

const embedQuery = async (query: string): Promise<Embedded> => {
  try {
    const provider = createEmbeddingProvider({ maxAttempts: 1, timeoutMs: EMBED_TIMEOUT_MS });
    const { vectors } = await provider.embed([query], 'query');

    return { model: provider.model, profileId: provider.profileId, vector: vectors[0] };
  } catch (error) {
    Sentry.captureException(error);

    const limited =
      error instanceof EmbeddingRequestError && (error.status === 429 || error.quotaExhausted);

    return { status: limited ? 'QUOTA_EXHAUSTED' : 'UNAVAILABLE' };
  }
};

interface SearchResponse {
  status: 'OK' | 'QUOTA_EXHAUSTED' | 'UNAVAILABLE';
  results: { score: number; incident: DBIncident }[];
}

/** Embeds the semantic text and returns the allowed incidents that are closest to it in meaning. */
const searchByMeaning = async (
  context: Context,
  semanticText: string,
  limit: number,
  allowedIncidentIds?: ReadonlySet<number>
): Promise<SearchResponse> => {
  const embedded = await embedQuery(semanticText);
  if ('status' in embedded) return { status: embedded.status, results: [] };

  try {
    const stored = await loadVectors(
      context,
      embedded.model,
      embedded.profileId,
      embedded.vector.length
    );

    if (stored.length === 0) return { status: 'UNAVAILABLE', results: [] };

    const hits = rankIncidentVectors(stored, embedded.vector, limit, MIN_SCORE, allowedIncidentIds);
    const incidents = await context.client
      .db('aiidprod')
      .collection<DBIncident>('incidents')
      .find({ incident_id: { $in: hits.map((hit) => hit.incident_id) } })
      .toArray();
    const byId = new Map(incidents.map((incident) => [incident.incident_id, incident]));
    const results = hits.flatMap((hit) => {
      const incident = byId.get(hit.incident_id);

      return incident ? [{ score: hit.score, incident }] : [];
    });

    return { status: 'OK', results };
  } catch (error) {
    Sentry.captureException(error);
    return { status: 'UNAVAILABLE', results: [] };
  }
};

const plainInterpretation = (query: string) => ({
  semanticText: query,
  constraints: [],
  warnings: [],
});

/**
 * Reads the query's constraints and works out which incidents they leave. `allowedIncidentIds` is
 * undefined when nothing constrains the search, so an unconstrained search ranks exactly as before.
 */
const interpret = (query: string, facts: IncidentFacts) => {
  const { semanticText, constraints, warnings } = parseQuery(query, facts);

  const applied = constraints.map((constraint) => ({
    constraint,
    incidents: facts.incidentsWith(
      constraint.entities.map((entity) => entity.entityId),
      constraint.roles
    ),
  }));

  const excluded = new Set(applied.flatMap(({ incidents }) => Array.from(incidents)));

  const allowedIncidentIds =
    applied.length > 0
      ? new Set(Array.from(facts.incidentIds).filter((incidentId) => !excluded.has(incidentId)))
      : undefined;

  const interpretation = {
    semanticText,
    warnings,
    constraints: applied.map(({ constraint, incidents }) => ({
      kind: constraint.kind,
      source: constraint.source,
      matchedText: constraint.matchedText,
      entities: constraint.entities.map(({ entityId, name, matchedBy }) => ({
        entity_id: entityId,
        name,
        matchedBy,
      })),
      incidentCount: incidents.size,
    })),
  };

  return { interpretation, allowedIncidentIds };
};

export const queryFields: GraphQLFieldConfigMap<any, Context> = {
  semanticSearch: {
    type: new GraphQLNonNull(SemanticSearchResponseType),
    description: 'Incidents ranked by their semantic similarity to a free-text query.',
    args: {
      query: { type: new GraphQLNonNull(GraphQLString) },
      limit: { type: GraphQLInt, defaultValue: DEFAULT_LIMIT },
    },
    resolve: async (_source, args, context) => {
      const query = String(args.query).trim().slice(0, MAX_QUERY_CHARS);
      const limit = Math.min(
        Math.max(Math.trunc(Number(args.limit) || DEFAULT_LIMIT), 1),
        MAX_LIMIT
      );

      if (!query) return { status: 'OK', results: [], interpretation: plainInterpretation(query) };

      let facts: IncidentFacts;

      try {
        facts = await cachedFacts(FACTS_CACHE_KEY, () => loadIncidentFacts(context.client));
      } catch (error) {
        Sentry.captureException(error);
        return { status: 'UNAVAILABLE', results: [], interpretation: plainInterpretation(query) };
      }

      // Only the semantic text is embedded. It is settled here, before any embedding request,
      // so a search with nothing to embed never spends one and excluded words are never sent.
      const { interpretation, allowedIncidentIds } = interpret(query, facts);
      const { semanticText } = interpretation;

      if (!semanticText) return { status: 'OK', results: [], interpretation };

      const response = await searchByMeaning(context, semanticText, limit, allowedIncidentIds);

      return { ...response, interpretation };
    },
  },
};

export const permissions = {
  Query: {
    semanticSearch: allow,
  },
};
