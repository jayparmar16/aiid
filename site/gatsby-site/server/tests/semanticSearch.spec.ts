import { ApolloServer } from '@apollo/server';
import * as Sentry from '@sentry/aws-serverless';
import { Binary } from 'mongodb';
import { API_LOGIN_REQUIRED } from '../apiAccess';
import {
  normaliseBinaryVector,
  rankIncidentVectors,
  resetSemanticSearchCache,
} from '../fields/semanticSearch';
import {
  makeRequest,
  mockAnonymousSession,
  mockSession,
  seedCollection,
  startTestServer,
} from './utils';

jest.mock('@sentry/aws-serverless', () => ({ captureException: jest.fn() }));

const vector = (values: number[]) => Binary.fromFloat32Array(Float32Array.from(values));

describe('semantic search vector helpers', () => {
  it('decodes and normalises Float32 BSON vectors', () => {
    const normalised = normaliseBinaryVector(vector([3, 4]), 2);

    expect(Array.from(normalised || [])).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(normaliseBinaryVector(vector([0, 0]), 2)).toBeNull();
    expect(normaliseBinaryVector(vector([1, 2]), 3)).toBeNull();
  });

  it('weights overview and best-passage similarity and applies ordering, threshold, and limit', () => {
    const incidents = [
      {
        incidentId: 1,
        overview: Float32Array.from([1, 0]),
        passages: [Float32Array.from([0, 1])],
      },
      {
        incidentId: 2,
        overview: Float32Array.from([0.6, 0.8]),
        passages: [Float32Array.from([1, 0]), Float32Array.from([0, 1])],
      },
      {
        incidentId: 3,
        overview: Float32Array.from([-1, 0]),
        passages: [],
      },
    ];

    const results = rankIncidentVectors(incidents, [1, 0], 1, 0.15);

    expect(results).toHaveLength(1);
    expect(results[0].incident_id).toBe(2);
    expect(results[0].score).toBeCloseTo(0.74);
  });

  it('uses the overview score when an incident has no passage vectors', () => {
    const results = rankIncidentVectors(
      [{ incidentId: 7, overview: Float32Array.from([1, 0]), passages: [] }],
      [2, 0],
      10
    );

    expect(results[0]).toMatchObject({ incident_id: 7, score: 1 });
  });

  it('fills the limit from allowed incidents only, even when a disallowed one scores higher', () => {
    const results = rankIncidentVectors(
      [
        { incidentId: 1, overview: Float32Array.from([1, 0]), passages: [] },
        { incidentId: 2, overview: Float32Array.from([0.8, 0.6]), passages: [] },
        { incidentId: 3, overview: Float32Array.from([0.6, 0.8]), passages: [] },
      ],
      [1, 0],
      1,
      0.15,
      new Set([2, 3])
    );

    expect(results.map((result) => result.incident_id)).toEqual([2]);
  });
});

describe('semanticSearch GraphQL field', () => {
  let server: ApolloServer;
  let url: string;
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    ({ server, url } = await startTestServer());
  });

  afterAll(async () => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    await server.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      EMBEDDING_API_KEY: 'test-key',
      EMBEDDING_API_BASE_URL: 'https://embedding.test/v1',
      EMBEDDING_MODEL: 'nvidia/nemotron-3-embed-1b:free',
    };
    delete process.env.NVIDIA_URL;
    delete process.env.NVIDIA_API_KEY;
    resetSemanticSearchCache();

    // The API requires a logged-in account (SEE: server/apiAccess.ts). A roleless
    // subscriber is enough, since the gate checks identity and not permission.
    await seedCollection({
      name: 'users',
      database: 'customData',
      docs: [{ userId: 'subscriber1', roles: ['subscriber'] }],
    });
    mockSession('subscriber1');

    await seedCollection({
      name: 'incidents',
      docs: [
        { incident_id: 1, title: 'Overview match', description: 'First', date: '2026-01-01' },
        { incident_id: 2, title: 'Passage match', description: 'Second', date: '2026-01-02' },
        { incident_id: 3, title: 'Legacy row', description: 'Ignored', date: '2026-01-03' },
        { incident_id: 4, title: 'New cache key', description: 'Third', date: '2026-01-04' },
      ],
    });
    await seedCollection({
      name: 'incident_embeddings',
      docs: [
        {
          incident_id: 1,
          embedding_schema_version: 2,
          embedding_profile: 'nemotron-retrieval-v1',
          model: 'nvidia/nemotron-3-embed-1b:free',
          dims: 2,
          overview: { vector: vector([1, 0]) },
          passages: [{ vector: vector([0, 1]) }],
        },
        {
          incident_id: 2,
          embedding_schema_version: 2,
          embedding_profile: 'nemotron-retrieval-v1',
          model: 'nvidia/nemotron-3-embed-1b:free',
          dims: 2,
          overview: { vector: vector([0, 1]) },
          passages: [{ vector: vector([1, 0]) }],
        },
        {
          incident_id: 3,
          embedding_schema_version: 1,
          embedding_profile: 'nemotron-retrieval-v1',
          model: 'nvidia/nemotron-3-embed-1b:free',
          dims: 2,
          overview: { vector: vector([1, 0]) },
          passages: [],
        },
        {
          incident_id: 3,
          embedding_schema_version: 2,
          embedding_profile: 'openai-compatible-v1',
          model: 'nvidia/nemotron-3-embed-1b:free',
          dims: 2,
          overview: { vector: vector([1, 0]) },
          passages: [],
        },
        {
          incident_id: 3,
          embedding_schema_version: 2,
          embedding_profile: 'nemotron-retrieval-v1',
          model: 'vendor/other-model',
          dims: 2,
          overview: { vector: vector([1, 0]) },
          passages: [],
        },
        {
          incident_id: 3,
          embedding_schema_version: 2,
          embedding_profile: 'nemotron-retrieval-v1',
          model: 'nvidia/nemotron-3-embed-1b:free',
          dims: 3,
          overview: { vector: vector([1, 0, 0]) },
          passages: [],
        },
      ],
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const execute = (query: string) =>
    makeRequest(url, {
      query: `
        query SemanticSearch($query: String!) {
          semanticSearch(query: $query) {
            status
            results { score incident { incident_id title } }
          }
        }
      `,
      variables: { query },
    });

  it('returns ranked schema-v2 incidents and ignores legacy embedding documents', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const response = await execute('matching query');

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.semanticSearch.status).toBe('OK');
    expect(
      response.body.data.semanticSearch.results.map((result: any) => result.incident.incident_id)
    ).toEqual([1, 2]);
  });

  it('requires a logged-in account and does not call the provider without one', async () => {
    global.fetch = jest.fn();
    mockAnonymousSession();

    const response = await execute('matching query');

    expect(response.body.errors[0]).toMatchObject({ extensions: { code: API_LOGIN_REQUIRED } });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not call the provider for an empty query', async () => {
    global.fetch = jest.fn();

    const response = await execute('   ');

    expect(response.body.data.semanticSearch).toEqual({ status: 'OK', results: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps provider quota exhaustion to QUOTA_EXHAUSTED', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } })
      );

    const response = await execute('query');

    expect(response.body.data.semanticSearch).toEqual({
      status: 'QUOTA_EXHAUSTED',
      results: [],
    });
  });

  it('maps provider failures to UNAVAILABLE and reports them to Sentry', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('provider unavailable'));

    const response = await execute('query');

    expect(response.body.data.semanticSearch).toEqual({ status: 'UNAVAILABLE', results: [] });
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('returns UNAVAILABLE when no current embeddings exist', async () => {
    await seedCollection({ name: 'incident_embeddings', docs: [] });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const response = await execute('query');

    expect(response.body.data.semanticSearch).toEqual({ status: 'UNAVAILABLE', results: [] });
  });

  it('reloads vectors when the embedding dimensions change', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const firstResponse = await execute('two dimensions');

    expect(firstResponse.body.data.semanticSearch.results[0].incident.incident_id).toBe(1);

    await seedCollection({
      name: 'incident_embeddings',
      docs: [
        {
          incident_id: 4,
          embedding_schema_version: 2,
          embedding_profile: 'nemotron-retrieval-v1',
          model: 'nvidia/nemotron-3-embed-1b:free',
          dims: 3,
          overview: { vector: vector([1, 0, 0]) },
          passages: [],
        },
      ],
    });
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const response = await execute('three dimensions');

    expect(response.body.data.semanticSearch.status).toBe('OK');
    expect(response.body.data.semanticSearch.results).toHaveLength(1);
    expect(response.body.data.semanticSearch.results[0].incident.incident_id).toBe(4);
  });
});

describe('semanticSearch exclusions', () => {
  let server: ApolloServer;
  let url: string;
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  /** Every text the embedding endpoint received, in order. */
  let embedded: string[];

  const stubEmbedding = (response: () => Promise<Response>) => {
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      embedded.push(...JSON.parse(String(init?.body)).input);
      return response();
    }) as unknown as typeof fetch;
  };

  const embedAs = (values: number[]) =>
    stubEmbedding(
      async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: values }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

  const incident = (
    incident_id: number,
    title: string,
    roles: { deployer?: string[]; developer?: string[]; implicated?: string[]; harmed?: string[] },
    reports: number[] = []
  ) => ({
    incident_id,
    title,
    description: title,
    date: '2024-01-01',
    reports,
    'Alleged deployer of AI system': roles.deployer ?? [],
    'Alleged developer of AI system': roles.developer ?? [],
    implicated_systems: roles.implicated ?? [],
    'Alleged harmed or nearly harmed parties': roles.harmed ?? [],
  });

  const vectors = (incident_id: number, values: number[]) => ({
    incident_id,
    embedding_schema_version: 2,
    embedding_profile: 'nemotron-retrieval-v1',
    model: 'nvidia/nemotron-3-embed-1b:free',
    dims: 2,
    overview: { vector: vector(values) },
    passages: [],
  });

  const search = (
    query: string,
    variables: { limit?: number; filters?: { excludeEntities?: string[] } } = {}
  ) =>
    makeRequest(url, {
      query: `
        query SemanticSearch($query: String!, $limit: Int, $filters: SemanticSearchFilters) {
          semanticSearch(query: $query, limit: $limit, filters: $filters) {
            status
            results { incident { incident_id } }
            interpretation {
              semanticText
              constraints {
                kind
                source
                matchedText
                incidentCount
                entities { entity_id name matchedBy }
              }
              warnings { code text }
            }
          }
        }
      `,
      variables: { query, ...variables },
    });

  const resultIds = (response: any) =>
    response.body.data.semanticSearch.results.map((result: any) => result.incident.incident_id);

  const interpretationOf = (response: any) => response.body.data.semanticSearch.interpretation;

  const excludedIds = (response: any) =>
    interpretationOf(response).constraints.map((constraint: any) =>
      constraint.entities.map((entity: any) => entity.entity_id)
    );

  beforeAll(async () => {
    ({ server, url } = await startTestServer());
  });

  afterAll(async () => {
    process.env = originalEnv;
    global.fetch = originalFetch;
    await server.stop();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    embedded = [];
    process.env = {
      ...originalEnv,
      EMBEDDING_API_KEY: 'test-key',
      EMBEDDING_API_BASE_URL: 'https://embedding.test/v1',
      EMBEDDING_MODEL: 'nvidia/nemotron-3-embed-1b:free',
    };
    delete process.env.NVIDIA_URL;
    delete process.env.NVIDIA_API_KEY;
    resetSemanticSearchCache();

    await seedCollection({
      name: 'users',
      database: 'customData',
      docs: [{ userId: 'subscriber1', roles: ['subscriber'] }],
    });
    mockSession('subscriber1');

    await seedCollection({
      name: 'entities',
      docs: [
        { entity_id: 'tesla', name: 'Tesla' },
        { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot' },
        { entity_id: 'tesla-full-self-driving-(fsd)', name: 'Tesla Full Self-Driving (FSD)' },
        { entity_id: 'tesla-drivers', name: 'Tesla drivers' },
        { entity_id: 'uber', name: 'Uber' },
        { entity_id: 'waymo', name: 'Waymo' },
        { entity_id: 'clearview-ai', name: 'Clearview AI' },
        { entity_id: 'students', name: 'Students' },
      ],
    });

    // Scores against the query vector [1, 0]: 10 > 11 > 12 > 13 > 15, and 14 is below the threshold.
    await seedCollection({
      name: 'incidents',
      docs: [
        incident(10, 'Tesla on Autopilot crashes', {
          deployer: ['tesla'],
          developer: ['tesla'],
          implicated: ['tesla-autopilot'],
        }),
        incident(11, 'Full Self-Driving runs a red light', {
          implicated: ['tesla-full-self-driving-(fsd)'],
        }),
        // Its coverage compares Uber with Tesla, but Tesla has no role in the incident.
        incident(12, 'Uber test car kills a pedestrian', { deployer: ['uber'] }, [101]),
        // Tesla drivers were harmed here, which never makes Tesla responsible.
        incident(13, 'Waymo hits a Tesla', { deployer: ['waymo'], harmed: ['tesla-drivers'] }),
        incident(14, 'Unrelated incident', { deployer: ['clearview-ai'] }),
        incident(15, 'Students misuse a chatbot', { deployer: ['students'] }),
      ],
    });

    await seedCollection({
      name: 'reports',
      docs: [{ report_number: 101, plain_text: 'Unlike Tesla, Uber ran its own test fleet.' }],
    });

    await seedCollection({
      name: 'incident_embeddings',
      docs: [
        vectors(10, [1, 0]),
        vectors(11, [0.99, 0.14]),
        vectors(12, [0.95, 0.31]),
        vectors(13, [0.9, 0.44]),
        vectors(14, [0, 1]),
        vectors(15, [0.8, 0.6]),
      ],
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('removes incidents a Tesla-family entity is responsible for and embeds only the rest', async () => {
    embedAs([1, 0]);

    const response = await search('self-driving car incidents excluding tesla');

    expect(response.body.errors).toBeUndefined();
    expect(embedded).toEqual(['self-driving car incidents']);
    expect(resultIds(response)).toEqual([12, 13, 15]);
    expect(interpretationOf(response)).toEqual({
      semanticText: 'self-driving car incidents',
      warnings: [],
      constraints: [
        {
          kind: 'EXCLUDE_ENTITY',
          source: 'QUERY_TEXT',
          matchedText: 'tesla',
          incidentCount: 2,
          entities: [
            { entity_id: 'tesla', name: 'Tesla', matchedBy: 'NAME' },
            { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot', matchedBy: 'FAMILY' },
            {
              entity_id: 'tesla-full-self-driving-(fsd)',
              name: 'Tesla Full Self-Driving (FSD)',
              matchedBy: 'FAMILY',
            },
          ],
        },
      ],
    });
  });

  it.each([
    'self-driving crashes excluding tesla',
    'self-driving crashes, exclude tesla',
    'self-driving crashes except tesla',
    'self-driving crashes except for tesla',
    'self-driving crashes but not tesla',
    'self-driving crashes, not tesla',
    'self-driving crashes without tesla',
    'self-driving crashes other than tesla',
    'self-driving crashes apart from tesla',
    'self-driving crashes aside from tesla',
    'self-driving crashes not involving tesla',
    'non-tesla self-driving crashes',
    'self-driving crashes -tesla',
  ])('reads an exclusion from %p', async (query) => {
    embedAs([1, 0]);

    const response = await search(query);

    expect(embedded).toEqual(['self-driving crashes']);
    expect(excludedIds(response)).toEqual([
      ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
    ]);
    expect(resultIds(response)).toEqual([12, 13, 15]);
  });

  it('excludes each name in a list and stops at the first unknown one', async () => {
    embedAs([1, 0]);

    const listed = await search('self-driving crashes excluding tesla, waymo and uber');

    expect(excludedIds(listed)).toEqual([
      ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
      ['waymo'],
      ['uber'],
    ]);
    expect(resultIds(listed)).toEqual([15]);

    const stopped = await search('self-driving crashes excluding tesla and pedestrians');

    expect(excludedIds(stopped)).toEqual([
      ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
    ]);
    expect(interpretationOf(stopped).semanticText).toBe('self-driving crashes and pedestrians');
    expect(interpretationOf(stopped).warnings).toEqual([]);
  });

  it('prefers the longest name, ignores case and punctuation, and folds plurals', async () => {
    embedAs([1, 0]);

    const longest = await search('crashes excluding tesla autopilot');

    expect(excludedIds(longest)).toEqual([['tesla-autopilot']]);
    expect(resultIds(longest)).toEqual([11, 12, 13, 15]);

    const folded = await search('Self-driving crashes EXCLUDING Teslas!');

    expect(interpretationOf(folded).semanticText).toBe('Self-driving crashes!');
    expect(interpretationOf(folded).constraints[0].matchedText).toBe('Teslas');
    expect(excludedIds(folded)[0][0]).toBe('tesla');
  });

  it('accepts the start of a name after a strong phrase but not after a weak one', async () => {
    embedAs([1, 0]);

    const strong = await search('face recognition not involving clearview');

    expect(excludedIds(strong)).toEqual([['clearview-ai']]);

    const weak = await search('face recognition without clearview');

    expect(interpretationOf(weak).constraints).toEqual([]);
    expect(embedded).toEqual(['face recognition', 'face recognition without clearview']);
  });

  it('reports an unrecognised exclusion and never embeds its words', async () => {
    embedAs([1, 0]);

    const response = await search('deepfake scams excluding robocall operators');

    expect(embedded).toEqual(['deepfake scams']);
    expect(interpretationOf(response)).toEqual({
      semanticText: 'deepfake scams',
      constraints: [],
      warnings: [{ code: 'UNRECOGNISED_EXCLUSION', text: 'robocall operators' }],
    });
  });

  it.each([
    'chatbots that do not work',
    'non-consensual deepfakes',
    'cars without safety drivers',
    'tesla autopilot crashes',
    'students misusing chatbots',
  ])('leaves %p exactly as written', async (query) => {
    embedAs([1, 0]);

    const response = await search(query);

    expect(embedded).toEqual([query]);
    expect(interpretationOf(response)).toEqual({
      semanticText: query,
      constraints: [],
      warnings: [],
    });
  });

  it('fills the limit from incidents left after exclusion', async () => {
    embedAs([1, 0]);

    const response = await search('crashes excluding tesla', { limit: 1 });

    expect(resultIds(response)).toEqual([12]);
  });

  it('returns the interpretation when embedding is limited or unavailable', async () => {
    stubEmbedding(async () => new Response('rate limited', { status: 429 }));

    const limited = await search('crashes excluding tesla');

    expect(limited.body.data.semanticSearch.status).toBe('QUOTA_EXHAUSTED');
    expect(excludedIds(limited)).toEqual([
      ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
    ]);

    stubEmbedding(async () => {
      throw new Error('provider unavailable');
    });

    const unavailable = await search('crashes excluding tesla');

    expect(unavailable.body.data.semanticSearch.status).toBe('UNAVAILABLE');
    expect(interpretationOf(unavailable).semanticText).toBe('crashes');
  });

  it('keeps entity facts until the cache is reset, then sees new entities', async () => {
    embedAs([1, 0]);

    expect(interpretationOf(await search('crashes excluding nova')).warnings).toHaveLength(1);

    await seedCollection({
      name: 'entities',
      docs: [{ entity_id: 'nova', name: 'Nova' }],
      drop: false,
    });
    await seedCollection({
      name: 'incidents',
      docs: [incident(16, 'Nova robotaxi stalls', { deployer: ['nova'] })],
      drop: false,
    });

    expect(interpretationOf(await search('crashes excluding nova')).warnings).toHaveLength(1);

    resetSemanticSearchCache();

    expect(excludedIds(await search('crashes excluding nova'))).toEqual([['nova']]);
  });

  it('applies an explicit exclusion exactly as a typed one', async () => {
    embedAs([1, 0]);

    const typed = await search('self-driving car incidents excluding tesla');
    const explicit = await search('self-driving car incidents', {
      filters: { excludeEntities: ['tesla'] },
    });

    expect(explicit.body.errors).toBeUndefined();
    expect(embedded).toEqual(['self-driving car incidents', 'self-driving car incidents']);
    expect(resultIds(explicit)).toEqual([12, 13, 15]);
    expect(interpretationOf(explicit)).toEqual({
      semanticText: 'self-driving car incidents',
      warnings: [],
      constraints: [
        {
          ...interpretationOf(typed).constraints[0],
          source: 'EXPLICIT_FILTER',
          matchedText: 'Tesla',
        },
      ],
    });
  });

  it('merges explicit and typed exclusions, keeping each one once', async () => {
    embedAs([1, 0]);

    const response = await search('crashes excluding waymo and teslas', {
      filters: { excludeEntities: ['tesla', 'uber', 'tesla'] },
    });

    expect(embedded).toEqual(['crashes']);
    expect(
      interpretationOf(response).constraints.map(({ source, matchedText }: any) => [
        source,
        matchedText,
      ])
    ).toEqual([
      ['EXPLICIT_FILTER', 'Tesla'],
      ['EXPLICIT_FILTER', 'Uber'],
      ['QUERY_TEXT', 'waymo'],
    ]);
    expect(resultIds(response)).toEqual([15]);
  });

  it('reproduces each constraint from its first entity, as the page sends them back', async () => {
    embedAs([1, 0]);

    const typed = await search('crashes excluding tesla, waymo and clearview');
    const { semanticText, constraints } = interpretationOf(typed);

    const held = await search(semanticText, {
      filters: {
        excludeEntities: constraints.map((constraint: any) => constraint.entities[0].entity_id),
      },
    });

    expect(embedded).toEqual(['crashes', 'crashes']);
    expect(excludedIds(held)).toEqual(excludedIds(typed));
    expect(
      interpretationOf(held).constraints.map((constraint: any) => constraint.incidentCount)
    ).toEqual(constraints.map((constraint: any) => constraint.incidentCount));
    expect(resultIds(held)).toEqual(resultIds(typed));
  });

  it('reports unknown entity ids as warnings and searches without them', async () => {
    embedAs([1, 0]);

    const response = await search('crashes', {
      filters: { excludeEntities: ['no-such-entity', 'tesla-drivers'] },
    });

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.semanticSearch.status).toBe('OK');
    expect(interpretationOf(response)).toEqual({
      semanticText: 'crashes',
      constraints: [],
      warnings: [
        { code: 'UNKNOWN_ENTITY', text: 'no-such-entity' },
        // Tesla drivers are only ever a harmed party, so there is nothing to exclude them from.
        { code: 'UNKNOWN_ENTITY', text: 'tesla-drivers' },
      ],
    });
    expect(resultIds(response)).toEqual([10, 11, 12, 13, 15]);
  });

  it('reads explicit filters when the query is empty, without embedding anything', async () => {
    embedAs([1, 0]);

    const response = await search('  ', { filters: { excludeEntities: ['tesla'] } });

    expect(response.body.errors).toBeUndefined();
    expect(embedded).toEqual([]);
    expect(interpretationOf(response).semanticText).toBe('');
    expect(excludedIds(response)).toEqual([
      ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
    ]);
  });

  it('refuses more than 20 entity filters with an error saying so', async () => {
    embedAs([1, 0]);

    const ids = (count: number) => Array.from({ length: count }, (_, index) => `entity-${index}`);

    const accepted = await search('crashes', { filters: { excludeEntities: ids(20) } });

    expect(accepted.body.errors).toBeUndefined();
    expect(interpretationOf(accepted).warnings).toHaveLength(20);

    const refused = await search('crashes', { filters: { excludeEntities: ids(21) } });

    expect(refused.body.data).toBeNull();
    expect(refused.body.errors).toEqual([
      expect.objectContaining({
        message: 'A search takes at most 20 entity filters, but 21 were given.',
        extensions: expect.objectContaining({ code: 'BAD_USER_INPUT' }),
      }),
    ]);
    expect(embedded).toEqual(['crashes']);
  });
});
