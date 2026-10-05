import * as Sentry from '@sentry/aws-serverless';
import { Binary } from 'mongodb';
import {
  GraphQLEnumType,
  GraphQLError,
  GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLInputObjectType,
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
import {
  Constraint,
  EntityRole,
  HARMED_ROLES,
  InterpretationWarning,
  meaningLeftIn,
  parseQuery,
  readExcludedName,
  readIncludedName,
  ResolvedEntity,
  RESPONSIBLE_ROLES,
  Suggestion,
  toWords,
} from '../semanticSearch/parseQuery';
import { IncidentType } from '../types/incidents';

const EMBEDDING_SCHEMA_VERSION = 2;
const MAX_QUERY_CHARS = 500;
const MAX_ENTITY_FILTERS = 20;
const MAX_SUGGESTIONS = 3;
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
      type: GraphQLFloat,
      description:
        'Weighted cosine similarity across the incident overview and best passage. Null when nothing was left to rank by meaning and results are listed newest first.',
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
            LINK: {
              description:
                'Editors linked the entity to the one whose whole name was written. Only direct links are followed.',
            },
          },
        })
      ),
    },
  },
});

const SemanticSearchRoleType = new GraphQLEnumType({
  name: 'SemanticSearchRole',
  description: 'A role an entity can have in an incident.',
  values: {
    DEPLOYER: { value: 'deployer', description: 'Alleged deployer of the AI system.' },
    DEVELOPER: { value: 'developer', description: 'Alleged developer of the AI system.' },
    IMPLICATED: { value: 'implicated', description: 'Implicated AI system.' },
    HARMED: { value: 'harmed', description: 'Alleged harmed or nearly harmed party.' },
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
            INCLUDE_ENTITY: {
              description:
                'Keeps only incidents in which a covered entity has one of the roles: by default the alleged deployer, developer or implicated system.',
            },
            HARMED_PARTY: {
              description:
                'Keeps only incidents in which a covered entity is an alleged harmed or nearly harmed party.',
            },
          },
        })
      ),
    },
    source: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'SemanticSearchConstraintSource',
          values: {
            QUERY_TEXT: { description: 'Read from the query text.' },
            EXPLICIT_FILTER: { description: 'Passed in the filters argument.' },
          },
        })
      ),
    },
    matchedText: {
      type: GraphQLString,
      description:
        'The words in the query that named what the constraint covers or, for an explicit filter, the name or entity id exactly as given, so a caller can tell which filter it came from.',
    },
    roles: {
      type: new GraphQLList(new GraphQLNonNull(SemanticSearchRoleType)),
      description: 'The roles in which the covered entities are looked for.',
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
                'The words after an exclusion, or a name in the filters, are not a known organisation or system, so nothing was excluded. The words were not searched for either.',
            },
            UNRECOGNISED_INCLUSION: {
              description:
                'A name in the `include` filters is not the whole name of an entity that occurs in its roles, so nothing was filtered on it.',
            },
            UNKNOWN_ENTITY: {
              description:
                'An entity id in the filters is unknown, or neither it nor any entity named after it ever has the roles the filter asks for, so that filter was not applied.',
            },
          },
        })
      ),
    },
    text: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The words or entity id concerned, as given.',
    },
  },
});

const SemanticSearchEntityFilterInput = new GraphQLInputObjectType({
  name: 'SemanticSearchEntityFilter',
  description:
    'An entity to keep incidents for, given by exactly one of `entityId` or `name`, with the roles it must have.',
  fields: {
    entityId: {
      type: GraphQLString,
      description:
        "Works as if the entity's whole name had been written: it also covers entities named after it and entities editors linked to it.",
    },
    name: {
      type: GraphQLString,
      description:
        'A name read exactly as if it had been written after "by", or after "affecting" for the harmed role. It must be one whole entity name. Sending back the matched text and roles of a constraint read from an earlier query applies the same constraint again.',
    },
    roles: {
      type: new GraphQLList(new GraphQLNonNull(SemanticSearchRoleType)),
      description:
        'Any of DEPLOYER, DEVELOPER and IMPLICATED, which is the default when left out, or HARMED on its own for an affected party.',
    },
  },
});

const SemanticSearchFiltersInput = new GraphQLInputObjectType({
  name: 'SemanticSearchFilters',
  description: `Constraints passed directly instead of written in the query. They merge with the constraints read from the query text. A search takes at most ${MAX_ENTITY_FILTERS} entity filters, ids and names together.`,
  fields: {
    excludeEntities: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
      description:
        'Entity ids to exclude. Each works as if the entity\'s whole name had been written after "excluding": it also covers entities named after it and entities editors linked to it, and it removes incidents in which they are the alleged deployer, developer or implicated system.',
    },
    excludeNames: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
      description:
        'Names to exclude, each read exactly as if it had been written after "excluding", including the first words of a name ("clearview" for "Clearview AI"). The whole text must be one name. Sending back the matched text of a constraint read from an earlier query applies the same constraint again.',
    },
    include: {
      type: new GraphQLList(new GraphQLNonNull(SemanticSearchEntityFilterInput)),
      description:
        'Entities to keep incidents for. Entries with the same roles mean "any of these", entries with different roles mean "all of these", and exclusions apply afterwards.',
    },
  },
});

const SemanticSearchSuggestionType = new GraphQLObjectType({
  name: 'SemanticSearchSuggestion',
  description:
    'A constraint the query hints at, offered for the user to apply rather than applied.',
  fields: {
    kind: {
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: 'SemanticSearchSuggestionKind',
          values: {
            INCLUDE_ENTITY: {
              description:
                'An entity mentioned without a linking word. Applying it means sending its id in `include`.',
            },
          },
        })
      ),
    },
    value: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'What to send to apply the suggestion: an entity id for INCLUDE_ENTITY.',
    },
    label: { type: new GraphQLNonNull(GraphQLString), description: 'A name to show for it.' },
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
    suggestions: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SemanticSearchSuggestionType))),
      description: `At most ${MAX_SUGGESTIONS}, in the order the query mentions them.`,
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
    totalCount: {
      type: new GraphQLNonNull(GraphQLInt),
      description:
        'How many incidents matched before the limit was applied: those scoring above the minimum when ranked by meaning, or every incident the constraints allow when listed newest first.',
    },
    interpretation: {
      type: new GraphQLNonNull(SemanticSearchInterpretationType),
      description: 'Returned with every status, so a caller can show how the query was read.',
    },
  },
});

const SemanticSearchFacetEntityType = new GraphQLObjectType({
  name: 'SemanticSearchFacetEntity',
  fields: {
    entity_id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const SemanticSearchFacetsType = new GraphQLObjectType({
  name: 'SemanticSearchFacets',
  description: 'The values a search can be filtered on, for building filter controls.',
  fields: {
    responsibleEntities: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SemanticSearchFacetEntityType))),
      description:
        'Every entity that is the alleged deployer, developer or implicated system of an incident, ordered by name. Any of their ids can be passed in `excludeEntities` or `include`.',
    },
    harmedEntities: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(SemanticSearchFacetEntityType))),
      description:
        'Every entity that is an alleged harmed or nearly harmed party in an incident, ordered by name. Any of their ids can be passed in `include` with the HARMED role.',
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
  results: { score: number | null; incident: DBIncident }[];
  totalCount: number;
}

const noResults = (status: SearchResponse['status']): SearchResponse => ({
  status,
  results: [],
  totalCount: 0,
});

/** The incidents with these ids, in the order given, skipping any that no longer exist. */
const findIncidents = async (context: Context, incidentIds: number[]) => {
  const incidents = await context.client
    .db('aiidprod')
    .collection<DBIncident>('incidents')
    .find({ incident_id: { $in: incidentIds } })
    .toArray();
  const byId = new Map(incidents.map((incident) => [incident.incident_id, incident]));

  return incidentIds.flatMap((incidentId) => {
    const incident = byId.get(incidentId);

    return incident ? [incident] : [];
  });
};

/** Embeds the semantic text and returns the allowed incidents that are closest to it in meaning. */
const searchByMeaning = async (
  context: Context,
  semanticText: string,
  limit: number,
  allowedIncidentIds?: ReadonlySet<number>
): Promise<SearchResponse> => {
  const embedded = await embedQuery(semanticText);
  if ('status' in embedded) return noResults(embedded.status);

  try {
    const stored = await loadVectors(
      context,
      embedded.model,
      embedded.profileId,
      embedded.vector.length
    );

    if (stored.length === 0) return noResults('UNAVAILABLE');

    // Every hit above the minimum score is kept, so the total can be reported before the limit.
    const ranked = rankIncidentVectors(
      stored,
      embedded.vector,
      Infinity,
      MIN_SCORE,
      allowedIncidentIds
    );
    const hits = ranked.slice(0, limit);
    const scores = new Map(hits.map((hit) => [hit.incident_id, hit.score]));
    const incidents = await findIncidents(
      context,
      hits.map((hit) => hit.incident_id)
    );

    return {
      status: 'OK',
      results: incidents.map((incident) => ({
        score: scores.get(incident.incident_id)!,
        incident,
      })),
      totalCount: ranked.length,
    };
  } catch (error) {
    Sentry.captureException(error);
    return noResults('UNAVAILABLE');
  }
};

/**
 * Lists the allowed incidents newest first, for a search with nothing left to rank by meaning. It
 * needs no embedding request, so it spends none of the provider's allowance. Incidents dated the
 * same day are listed newest id first.
 */
const listNewestFirst = async (
  context: Context,
  facts: IncidentFacts,
  allowedIncidentIds: ReadonlySet<number>,
  limit: number
): Promise<SearchResponse> => {
  const newest = Array.from(allowedIncidentIds)
    .sort((left, right) => facts.dateOf(right).localeCompare(facts.dateOf(left)) || right - left)
    .slice(0, limit);

  try {
    const incidents = await findIncidents(context, newest);

    return {
      status: 'OK',
      results: incidents.map((incident) => ({ score: null, incident })),
      totalCount: allowedIncidentIds.size,
    };
  } catch (error) {
    Sentry.captureException(error);
    return noResults('UNAVAILABLE');
  }
};

const plainInterpretation = (query: string) => ({
  semanticText: query,
  constraints: [],
  warnings: [],
  suggestions: [],
});

interface EntityFilter {
  entityId?: string | null;
  name?: string | null;
  roles?: EntityRole[] | null;
}

interface SemanticSearchFilters {
  excludeEntities?: string[] | null;
  excludeNames?: string[] | null;
  include?: EntityFilter[] | null;
}

/** Roles in one fixed order, so the same roles given in any order make the same constraint. */
const inRoleOrder = (roles: readonly EntityRole[]) =>
  [...RESPONSIBLE_ROLES, ...HARMED_ROLES].filter((role) => roles.includes(role));

/** Why an inclusion filter can't be read, or undefined when it can. */
const invalidInclusion = ({ entityId, name, roles }: EntityFilter) => {
  if (Boolean(entityId) === Boolean(name)) {
    return 'Each include filter takes exactly one of entityId and name.';
  }

  if (roles?.includes('harmed') && roles.length > 1) {
    return 'The HARMED role cannot be combined with other roles in one include filter.';
  }

  return undefined;
};

/**
 * Reads each excluded entity id as if the entity's whole name had been typed after "excluding",
 * and each excluded name as if it had been typed there itself, so an explicit exclusion covers
 * exactly the entities a typed one would. Each constraint's matched text is the id or name as
 * given, which tells a caller which filter it came from.
 */
const explicitExclusions = (filters: SemanticSearchFilters, facts: IncidentFacts) => {
  const constraints: Constraint[] = [];
  const warnings: InterpretationWarning[] = [];

  const exclude = (matchedText: string, entities: ResolvedEntity[]) =>
    constraints.push({
      kind: 'EXCLUDE_ENTITY',
      source: 'EXPLICIT_FILTER',
      matchedText,
      roles: RESPONSIBLE_ROLES,
      entities,
    });

  for (const entityId of new Set(filters.excludeEntities ?? [])) {
    const name = facts.nameOf(entityId);
    const entities = name ? facts.resolve(toWords(name), RESPONSIBLE_ROLES) : [];

    if (entities.length > 0) exclude(entityId, entities);
    else warnings.push({ code: 'UNKNOWN_ENTITY', text: entityId });
  }

  for (const name of new Set(filters.excludeNames ?? [])) {
    const entities = readExcludedName(name, facts);

    if (entities.length > 0) exclude(name, entities);
    else warnings.push({ code: 'UNRECOGNISED_EXCLUSION', text: name });
  }

  return { constraints, warnings };
};

/**
 * Reads each included entity id as if the entity's whole name had been typed after a linking word
 * with the same roles, and each name as if it had been typed there itself, so an explicit inclusion
 * covers exactly the entities a typed one would. The HARMED role on its own makes an affected party.
 */
const explicitInclusions = (filters: SemanticSearchFilters, facts: IncidentFacts) => {
  const constraints: Constraint[] = [];
  const warnings: InterpretationWarning[] = [];
  const seen = new Set<string>();

  for (const filter of filters.include ?? []) {
    const roles = inRoleOrder(filter.roles?.length ? filter.roles : RESPONSIBLE_ROLES);
    const key = JSON.stringify([filter.entityId, filter.name, roles]);

    if (seen.has(key)) continue;
    seen.add(key);

    let entities: ResolvedEntity[];

    if (filter.entityId) {
      const name = facts.nameOf(filter.entityId);

      entities = name ? facts.resolve(toWords(name), roles) : [];
      if (entities.length === 0) warnings.push({ code: 'UNKNOWN_ENTITY', text: filter.entityId });
    } else {
      entities = readIncludedName(filter.name!, roles, facts);
      if (entities.length === 0)
        warnings.push({ code: 'UNRECOGNISED_INCLUSION', text: filter.name! });
    }

    if (entities.length > 0) {
      constraints.push({
        kind: roles.includes('harmed') ? 'HARMED_PARTY' : 'INCLUDE_ENTITY',
        source: 'EXPLICIT_FILTER',
        matchedText: filter.entityId || filter.name!,
        roles,
        entities,
      });
    }
  }

  return { constraints, warnings };
};

/**
 * The group a constraint that keeps incidents belongs to, or undefined for one that removes them.
 * Constraints in one group mean "any of these" and different groups mean "all of these": inclusions
 * group by their roles, so "by google and openai" is one group and "by google affecting students"
 * is two.
 */
const requirementGroup = (constraint: Constraint): string | undefined => {
  switch (constraint.kind) {
    case 'INCLUDE_ENTITY':
      return `include:${[...constraint.roles].sort().join(',')}`;
    case 'HARMED_PARTY':
      return 'harmed';
    default:
      return undefined;
  }
};

/**
 * The incidents left by constraints that each come with the incidents they apply to: those in every
 * group of requirements, minus those any exclusion applies to.
 */
const allowedBy = (
  applied: { constraint: Constraint; incidents: ReadonlySet<number> }[],
  incidentIds: ReadonlySet<number>
) => {
  const required = new Map<string, Set<number>>();
  const excluded = new Set<number>();

  for (const { constraint, incidents } of applied) {
    const group = requirementGroup(constraint);
    let into = excluded;

    if (group !== undefined) {
      into = required.get(group) ?? new Set<number>();
      required.set(group, into);
    }

    for (const incidentId of incidents) into.add(incidentId);
  }

  const groups = Array.from(required.values());

  return new Set(
    Array.from(incidentIds).filter(
      (incidentId) => !excluded.has(incidentId) && groups.every((group) => group.has(incidentId))
    )
  );
};

/**
 * Keeps the first of any constraints that cover the same entities in the same way, so a page that
 * sends back the constraints it holds never gets one twice when the user types it again.
 */
const withoutRepeats = (constraints: Constraint[]) => {
  const seen = new Set<string>();

  return constraints.filter(({ kind, roles, entities }) => {
    const key = JSON.stringify([kind, roles, entities.map((entity) => entity.entityId).sort()]);

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
};

/**
 * Reads the query's constraints, merges them with the explicit filters and works out which
 * incidents they leave. `allowedIncidentIds` is undefined when nothing constrains the search, so an
 * unconstrained search ranks exactly as before.
 */
const interpret = (query: string, facts: IncidentFacts, filters: SemanticSearchFilters) => {
  const parsed = parseQuery(query, facts);
  const explicit = [explicitExclusions(filters, facts), explicitInclusions(filters, facts)];

  // Explicit filters come first, so the constraints a page sends back keep their order and newly
  // typed ones follow them.
  const constraints = withoutRepeats([
    ...explicit.flatMap((read) => read.constraints),
    ...parsed.constraints,
  ]);
  const warnings = [...explicit.flatMap((read) => read.warnings), ...parsed.warnings];

  const applied = constraints.map((constraint) => ({
    constraint,
    incidents: facts.incidentsWith(
      constraint.entities.map((entity) => entity.entityId),
      constraint.roles
    ),
  }));

  // Explicit filters are constraints taken out of the query too, so a query of filler words sent
  // with them leaves nothing to rank by meaning. Without constraints it is ranked as written.
  const semanticText =
    applied.length > 0 ? meaningLeftIn(parsed.semanticText) : parsed.semanticText;

  const allowedIncidentIds = applied.length > 0 ? allowedBy(applied, facts.incidentIds) : undefined;

  // A mention is offered only while no constraint covers it already, as after it was accepted.
  const covered = new Set(
    constraints.flatMap((constraint) => constraint.entities.map((entity) => entity.entityId))
  );
  const suggestions = parsed.suggestions
    .filter((suggestion: Suggestion) => !covered.has(suggestion.value))
    .slice(0, MAX_SUGGESTIONS);

  const interpretation = {
    semanticText,
    warnings,
    suggestions,
    constraints: applied.map(({ constraint, incidents }) => ({
      kind: constraint.kind,
      source: constraint.source,
      matchedText: constraint.matchedText,
      roles: constraint.roles,
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

const asFacetEntity = ({ entityId, name }: { entityId: string; name: string }) => ({
  entity_id: entityId,
  name,
});

export const queryFields: GraphQLFieldConfigMap<any, Context> = {
  semanticSearch: {
    type: new GraphQLNonNull(SemanticSearchResponseType),
    description: 'Incidents ranked by their semantic similarity to a free-text query.',
    args: {
      query: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'May be empty when filters are given.',
      },
      limit: { type: GraphQLInt, defaultValue: DEFAULT_LIMIT },
      filters: { type: SemanticSearchFiltersInput },
    },
    resolve: async (_source, args, context) => {
      const query = String(args.query).trim().slice(0, MAX_QUERY_CHARS);
      const limit = Math.min(
        Math.max(Math.trunc(Number(args.limit) || DEFAULT_LIMIT), 1),
        MAX_LIMIT
      );
      const filters: SemanticSearchFilters = args.filters ?? {};
      const entityFilterCount =
        (filters.excludeEntities?.length ?? 0) +
        (filters.excludeNames?.length ?? 0) +
        (filters.include?.length ?? 0);

      // Each entity filter costs a name expansion and an incident lookup, so their number is capped.
      // The error is returned, not thrown: in production the permissions layer replaces thrown
      // errors with a generic "not authorised", which would hide what the caller needs to fix.
      if (entityFilterCount > MAX_ENTITY_FILTERS) {
        return new GraphQLError(
          `A search takes at most ${MAX_ENTITY_FILTERS} entity filters, but ${entityFilterCount} were given.`,
          { extensions: { code: 'BAD_USER_INPUT' } }
        );
      }

      const invalid = (filters.include ?? []).map(invalidInclusion).find(Boolean);

      if (invalid) return new GraphQLError(invalid, { extensions: { code: 'BAD_USER_INPUT' } });

      if (!query && entityFilterCount === 0) {
        return { ...noResults('OK'), interpretation: plainInterpretation(query) };
      }

      let facts: IncidentFacts;

      try {
        facts = await cachedFacts(FACTS_CACHE_KEY, () => loadIncidentFacts(context.client));
      } catch (error) {
        Sentry.captureException(error);
        return { ...noResults('UNAVAILABLE'), interpretation: plainInterpretation(query) };
      }

      // Only the semantic text is embedded. It is settled here, before any embedding request,
      // so a search with nothing to embed never spends one and excluded words are never sent.
      const { interpretation, allowedIncidentIds } = interpret(query, facts, filters);
      const { semanticText } = interpretation;

      if (!semanticText) {
        const response = allowedIncidentIds
          ? await listNewestFirst(context, facts, allowedIncidentIds, limit)
          : noResults('OK');

        return { ...response, interpretation };
      }

      const response = await searchByMeaning(context, semanticText, limit, allowedIncidentIds);

      return { ...response, interpretation };
    },
  },
  semanticSearchFacets: {
    type: new GraphQLNonNull(SemanticSearchFacetsType),
    description: 'The values semantic search can be filtered on.',
    resolve: async (_source, _args, context) => {
      try {
        const facts = await cachedFacts(FACTS_CACHE_KEY, () => loadIncidentFacts(context.client));

        return {
          responsibleEntities: facts.responsibleEntities.map(asFacetEntity),
          harmedEntities: facts.harmedEntities.map(asFacetEntity),
        };
      } catch (error) {
        Sentry.captureException(error);

        // Returned rather than thrown, so the permissions layer does not mask it as "not authorised".
        return new GraphQLError('Search filters are unavailable right now.', {
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        });
      }
    },
  },
};

export const permissions = {
  Query: {
    semanticSearch: allow,
    semanticSearchFacets: allow,
  },
};
