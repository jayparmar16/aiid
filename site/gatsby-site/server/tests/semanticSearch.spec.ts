import { ApolloServer } from '@apollo/server';
import * as Sentry from '@sentry/aws-serverless';
import { Binary } from 'mongodb';
import { API_LOGIN_REQUIRED } from '../apiAccess';
import {
  normaliseBinaryVector,
  rankIncidentVectors,
  resetSemanticSearchCache,
  semanticSearchClock,
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
    variables: {
      limit?: number;
      filters?: { excludeEntities?: string[]; excludeNames?: string[] };
    } = {}
  ) =>
    makeRequest(url, {
      query: `
        query SemanticSearch($query: String!, $limit: Int, $filters: SemanticSearchFilters) {
          semanticSearch(query: $query, limit: $limit, filters: $filters) {
            status
            totalCount
            results { score incident { incident_id } }
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

    await seedCollection({ name: 'entity_relationships', docs: [] });

    // Scores against the query vector [1, 0]: 10 > 11 > 12 > 13 > 15, and 14 is below the threshold.
    // Newest first, they run 15 and 13 (the same day), 11, 14, 10, 12.
    await seedCollection({
      name: 'incidents',
      docs: [
        {
          ...incident(10, 'Tesla on Autopilot crashes', {
            deployer: ['tesla'],
            developer: ['tesla'],
            implicated: ['tesla-autopilot'],
          }),
          date: '2018-03-23',
        },
        {
          ...incident(11, 'Full Self-Driving runs a red light', {
            implicated: ['tesla-full-self-driving-(fsd)'],
          }),
          date: '2023-06-01',
        },
        // Its coverage compares Uber with Tesla, but Tesla has no role in the incident.
        {
          ...incident(12, 'Uber test car kills a pedestrian', { deployer: ['uber'] }, [101]),
          date: '2018-03-18',
        },
        // Tesla drivers were harmed here, which never makes Tesla responsible.
        {
          ...incident(13, 'Waymo hits a Tesla', { deployer: ['waymo'], harmed: ['tesla-drivers'] }),
          date: '2024-05-10',
        },
        {
          ...incident(14, 'Unrelated incident', { deployer: ['clearview-ai'] }),
          date: '2021-01-01',
        },
        {
          ...incident(15, 'Students misuse a chatbot', { deployer: ['students'] }),
          date: '2024-05-10',
        },
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

  it('applies an excluded entity id exactly as its typed name', async () => {
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
          matchedText: 'tesla',
        },
      ],
    });
  });

  it('merges explicit and typed exclusions, keeping each one once', async () => {
    embedAs([1, 0]);

    const response = await search('crashes excluding waymo and teslas', {
      filters: { excludeEntities: ['uber', 'uber'], excludeNames: ['Tesla', 'tesla'] },
    });

    expect(embedded).toEqual(['crashes']);
    expect(
      interpretationOf(response).constraints.map(({ source, matchedText }: any) => [
        source,
        matchedText,
      ])
    ).toEqual([
      ['EXPLICIT_FILTER', 'uber'],
      ['EXPLICIT_FILTER', 'Tesla'],
      ['QUERY_TEXT', 'waymo'],
    ]);
    expect(resultIds(response)).toEqual([15]);
  });

  it('reads each constraint again from its matched text, as the page sends them back', async () => {
    embedAs([1, 0]);

    // Several names start with "gpt" and none is just "GPT", so no one entity stands for them all.
    await seedCollection({
      name: 'entities',
      docs: [
        { entity_id: 'gpt-3', name: 'GPT-3' },
        { entity_id: 'gpt-4', name: 'GPT-4' },
      ],
      drop: false,
    });
    await seedCollection({
      name: 'incidents',
      docs: [
        incident(30, 'GPT-3 invents court cases', { implicated: ['gpt-3'] }),
        incident(31, 'GPT-4 reveals its instructions', { developer: ['gpt-4'] }),
      ],
      drop: false,
    });
    await seedCollection({
      name: 'incident_embeddings',
      docs: [vectors(30, [0.78, 0.63]), vectors(31, [0.76, 0.65])],
      drop: false,
    });

    const typed = await search('crashes excluding teslas, clearview and gpt');
    const { semanticText, constraints } = interpretationOf(typed);

    expect(excludedIds(typed)).toEqual([
      ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
      ['clearview-ai'],
      ['gpt-3', 'gpt-4'],
    ]);

    const held = await search(semanticText, {
      filters: { excludeNames: constraints.map((constraint: any) => constraint.matchedText) },
    });

    expect(embedded).toEqual(['crashes', 'crashes']);
    expect(interpretationOf(held)).toEqual({
      semanticText: 'crashes',
      warnings: [],
      constraints: constraints.map((constraint: any) => ({
        ...constraint,
        source: 'EXPLICIT_FILTER',
      })),
    });
    expect(resultIds(held)).toEqual([12, 13, 15]);
  });

  it('reports unknown entity ids and names as warnings and searches without them', async () => {
    embedAs([1, 0]);

    const response = await search('crashes', {
      filters: {
        excludeEntities: ['no-such-entity', 'tesla-drivers'],
        excludeNames: ['robocall operators', 'tesla vehicles'],
      },
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
        { code: 'UNRECOGNISED_EXCLUSION', text: 'robocall operators' },
        // A filter is one name, so words left over after a name make it unknown.
        { code: 'UNRECOGNISED_EXCLUSION', text: 'tesla vehicles' },
      ],
    });
    expect(resultIds(response)).toEqual([10, 11, 12, 13, 15]);
  });

  it('reads explicit filters when the query is empty, without embedding anything', async () => {
    embedAs([1, 0]);

    const response = await search('  ', { filters: { excludeNames: ['tesla'] } });

    expect(response.body.errors).toBeUndefined();
    expect(embedded).toEqual([]);
    expect(interpretationOf(response).semanticText).toBe('');
    expect(excludedIds(response)).toEqual([
      ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
    ]);
  });

  it('refuses more than 20 entity filters, ids and names together, saying so', async () => {
    embedAs([1, 0]);

    const values = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

    const accepted = await search('crashes', {
      filters: { excludeEntities: values('entity', 10), excludeNames: values('name', 10) },
    });

    expect(accepted.body.errors).toBeUndefined();
    expect(interpretationOf(accepted).warnings).toHaveLength(20);

    const refused = await search('crashes', {
      filters: { excludeEntities: values('entity', 10), excludeNames: values('name', 11) },
    });

    expect(refused.body.data).toBeNull();
    expect(refused.body.errors).toEqual([
      expect.objectContaining({
        message: 'A search takes at most 20 entity filters, but 21 were given.',
        extensions: expect.objectContaining({ code: 'BAD_USER_INPUT' }),
      }),
    ]);
    expect(embedded).toEqual(['crashes']);
  });

  describe('semanticSearchFacets', () => {
    const facets = () =>
      makeRequest(url, {
        query: `
          query SemanticSearchFacets {
            semanticSearchFacets {
              responsibleEntities { entity_id name }
            }
          }
        `,
      });

    const responsibleEntities = (response: any) =>
      response.body.data.semanticSearchFacets.responsibleEntities;

    it('lists every named entity responsible for an incident, by name, without embedding', async () => {
      global.fetch = jest.fn();

      await seedCollection({
        name: 'entities',
        docs: [{ entity_id: 'never-involved', name: 'Never Involved' }],
        drop: false,
      });
      await seedCollection({
        name: 'incidents',
        docs: [incident(16, 'An entity without a record', { deployer: ['nameless'] })],
        drop: false,
      });

      const response = await facets();

      expect(response.body.errors).toBeUndefined();
      // Tesla drivers are only ever harmed, so they are never offered as an organisation.
      expect(responsibleEntities(response)).toEqual([
        { entity_id: 'clearview-ai', name: 'Clearview AI' },
        { entity_id: 'students', name: 'Students' },
        { entity_id: 'tesla', name: 'Tesla' },
        { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot' },
        { entity_id: 'tesla-full-self-driving-(fsd)', name: 'Tesla Full Self-Driving (FSD)' },
        { entity_id: 'uber', name: 'Uber' },
        { entity_id: 'waymo', name: 'Waymo' },
      ]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('offers only entities a search can exclude by id', async () => {
      embedAs([1, 0]);

      const ids = responsibleEntities(await facets()).map((entity: any) => entity.entity_id);

      for (const id of ids) {
        const response = await search('crashes', { filters: { excludeEntities: [id] } });

        expect(interpretationOf(response).warnings).toEqual([]);
        expect(interpretationOf(response).constraints).toEqual([
          expect.objectContaining({ source: 'EXPLICIT_FILTER', matchedText: id }),
        ]);
      }
    });

    it('requires a logged-in account', async () => {
      mockAnonymousSession();

      const response = await facets();

      expect(response.body.errors[0]).toMatchObject({ extensions: { code: API_LOGIN_REQUIRED } });
    });

    it('keeps its entities until the cache is reset, then lists new ones', async () => {
      const before = responsibleEntities(await facets());

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

      expect(responsibleEntities(await facets())).toEqual(before);

      resetSemanticSearchCache();

      expect(responsibleEntities(await facets())).toContainEqual({
        entity_id: 'nova',
        name: 'Nova',
      });
    });
  });

  describe('with nothing left to rank by meaning', () => {
    const scoresOf = (response: any) =>
      response.body.data.semanticSearch.results.map((result: any) => result.score);

    it('lists the allowed incidents newest first, without embedding anything', async () => {
      embedAs([1, 0]);

      const response = await search('incidents excluding tesla');

      expect(response.body.errors).toBeUndefined();
      expect(embedded).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(response.body.data.semanticSearch.status).toBe('OK');
      expect(interpretationOf(response).semanticText).toBe('');
      expect(excludedIds(response)).toEqual([
        ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
      ]);
      // 15 and 13 share a date, so the newer id comes first. 14 is listed although no meaning
      // would have ranked it.
      expect(resultIds(response)).toEqual([15, 13, 14, 12]);
      expect(scoresOf(response)).toEqual([null, null, null, null]);
      expect(response.body.data.semanticSearch.totalCount).toBe(4);
    });

    it('stops at the limit and still counts every allowed incident', async () => {
      embedAs([1, 0]);

      const response = await search('incidents excluding tesla', { limit: 2 });

      expect(resultIds(response)).toEqual([15, 13]);
      expect(response.body.data.semanticSearch.totalCount).toBe(4);
    });

    it.each([
      'excluding tesla',
      'incidents excluding tesla',
      'Incident, excluding Tesla.',
      'cases except tesla',
      'related incidents excluding tesla',
      'incidents involving AI excluding tesla',
      'all the incidents excluding tesla',
    ])('treats what is left of %p as filler', async (query) => {
      embedAs([1, 0]);

      const response = await search(query);

      expect(embedded).toEqual([]);
      expect(interpretationOf(response).semanticText).toBe('');
      expect(resultIds(response)).toEqual([15, 13, 14, 12]);
    });

    it('embeds anything meaningful left over unchanged, filler included', async () => {
      embedAs([1, 0]);

      const response = await search('AI incidents involving robots, excluding tesla');

      expect(embedded).toEqual(['AI incidents involving robots']);
      expect(interpretationOf(response).semanticText).toBe('AI incidents involving robots');
      expect(scoresOf(response).every((score: unknown) => typeof score === 'number')).toBe(true);
    });

    it('embeds a query without constraints exactly as written, even when it is only filler', async () => {
      embedAs([1, 0]);

      const filler = await search('Incidents involving AI');
      const plain = await search('related incidents');

      expect(embedded).toEqual(['Incidents involving AI', 'related incidents']);
      expect(interpretationOf(filler).semanticText).toBe('Incidents involving AI');
      expect(resultIds(plain)).toEqual([10, 11, 12, 13, 15]);
    });

    it('takes the same path for an empty or filler query sent with explicit filters', async () => {
      embedAs([1, 0]);

      const empty = await search('', { filters: { excludeEntities: ['tesla'] } });
      const filler = await search('incidents', { filters: { excludeNames: ['tesla'] } });

      expect(embedded).toEqual([]);
      expect(resultIds(empty)).toEqual([15, 13, 14, 12]);
      expect(scoresOf(empty)).toEqual([null, null, null, null]);
      expect(empty.body.data.semanticSearch.totalCount).toBe(4);
      expect(interpretationOf(filler).semanticText).toBe('');
      expect(resultIds(filler)).toEqual([15, 13, 14, 12]);
    });

    it('returns nothing when no constraint applies', async () => {
      embedAs([1, 0]);

      const empty = await search('');
      const unknown = await search('', { filters: { excludeEntities: ['no-such-entity'] } });
      const unrecognised = await search('incidents excluding robocall operators');

      expect(embedded).toEqual([]);

      for (const response of [empty, unknown, unrecognised]) {
        expect(response.body.data.semanticSearch).toMatchObject({
          status: 'OK',
          results: [],
          totalCount: 0,
        });
      }

      expect(interpretationOf(unrecognised).warnings).toEqual([
        { code: 'UNRECOGNISED_EXCLUSION', text: 'robocall operators' },
      ]);
    });
  });

  describe('date ranges', () => {
    // Far from the real date, so a relative phrase that ignored the clock would fail.
    const now = new Date('2024-07-15T12:00:00Z');

    beforeEach(() => {
      jest.spyOn(semanticSearchClock, 'now').mockReturnValue(now);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const searchDates = (
      query: string,
      filters: {
        excludeEntities?: string[];
        excludeNames?: string[];
        dateFrom?: string | null;
        dateTo?: string | null;
      } = {}
    ) =>
      makeRequest(url, {
        query: `
          query SemanticSearch($query: String!, $filters: SemanticSearchFilters) {
            semanticSearch(query: $query, filters: $filters) {
              status
              totalCount
              results { score incident { incident_id } }
              interpretation {
                semanticText
                constraints {
                  kind
                  source
                  matchedText
                  incidentCount
                  dateFrom
                  dateTo
                  entities { entity_id }
                }
                warnings { code text }
              }
            }
          }
        `,
        variables: { query, filters },
      });

    const dateRanges = (response: any) =>
      interpretationOf(response).constraints.filter(
        (constraint: any) => constraint.kind === 'DATE_RANGE'
      );

    // Newest first, the fixtures run 15 and 13 (2024-05-10), 11 (2023-06-01), 14 (2021-01-01),
    // 10 (2018-03-23) and 12 (2018-03-18).
    it.each([
      ['incidents since 2021', 'since 2021', '2021-01-01', null, [15, 13, 11, 14]],
      ['incidents from 2022', 'from 2022', '2022-01-01', null, [15, 13, 11]],
      ['incidents after 2021', 'after 2021', '2022-01-01', null, [15, 13, 11]],
      ['incidents before 2021', 'before 2021', null, '2020-12-31', [10, 12]],
      ['incidents in 2018', 'in 2018', '2018-01-01', '2018-12-31', [10, 12]],
      [
        'incidents between 2021 and 2023',
        'between 2021 and 2023',
        '2021-01-01',
        '2023-12-31',
        [11, 14],
      ],
      ['incidents from 2021 to 2023', 'from 2021 to 2023', '2021-01-01', '2023-12-31', [11, 14]],
      ['incidents from 2023 to 2021', 'from 2023 to 2021', '2021-01-01', '2023-12-31', [11, 14]],
      ['incidents 2021-2023', '2021-2023', '2021-01-01', '2023-12-31', [11, 14]],
      ['incidents 2021–2023', '2021–2023', '2021-01-01', '2023-12-31', [11, 14]],
      ['incidents in 2021 - 2023', 'in 2021 - 2023', '2021-01-01', '2023-12-31', [11, 14]],
      ['incidents this year', 'this year', '2024-01-01', '2024-12-31', [15, 13]],
      ['incidents last year', 'last year', '2023-01-01', '2023-12-31', [11]],
      ['incidents past 3 years', 'past 3 years', '2021-07-15', '2024-07-15', [15, 13, 11]],
      [
        'incidents in the last 4 years',
        'in the last 4 years',
        '2020-07-15',
        '2024-07-15',
        [15, 13, 11, 14],
      ],
    ])(
      'reads %p as a date range and lists its incidents newest first',
      async (query, matchedText, dateFrom, dateTo, ids) => {
        embedAs([1, 0]);

        const response = await searchDates(query);

        expect(response.body.errors).toBeUndefined();
        expect(embedded).toEqual([]);
        expect(interpretationOf(response)).toEqual({
          semanticText: '',
          warnings: [],
          constraints: [
            {
              kind: 'DATE_RANGE',
              source: 'QUERY_TEXT',
              matchedText,
              dateFrom,
              dateTo,
              incidentCount: (ids as number[]).length,
              entities: [],
            },
          ],
        });
        expect(resultIds(response)).toEqual(ids);
        expect(response.body.data.semanticSearch.totalCount).toBe((ids as number[]).length);
      }
    );

    it('ranks only incidents in the range and embeds the query without its date', async () => {
      embedAs([1, 0]);

      const response = await searchDates('self-driving crashes since 2023');

      expect(embedded).toEqual(['self-driving crashes']);
      expect(interpretationOf(response).semanticText).toBe('self-driving crashes');
      // 10 and 12 score higher than all of these, but are dated 2018.
      expect(resultIds(response)).toEqual([11, 13, 15]);
    });

    it('ends an exclusion where a date phrase begins', async () => {
      embedAs([1, 0]);

      const weak = await searchDates('self-driving crashes not tesla since 2020');
      const unrecognised = await searchDates('crashes excluding robocall operators in 2018');

      expect(embedded).toEqual(['self-driving crashes', 'crashes']);
      expect(excludedIds(weak)).toEqual([
        ['tesla', 'tesla-autopilot', 'tesla-full-self-driving-(fsd)'],
        [],
      ]);
      expect(dateRanges(weak)).toEqual([expect.objectContaining({ dateFrom: '2020-01-01' })]);
      // 11 is Tesla's and 14 scores below the minimum.
      expect(resultIds(weak)).toEqual([13, 15]);

      expect(interpretationOf(unrecognised).warnings).toEqual([
        { code: 'UNRECOGNISED_EXCLUSION', text: 'robocall operators' },
      ]);
      expect(resultIds(unrecognised)).toEqual([10, 12]);
    });

    it('keeps only the dates every typed date phrase allows', async () => {
      embedAs([1, 0]);

      const response = await searchDates('incidents since 2019, before 2024');

      expect(dateRanges(response)).toEqual([
        expect.objectContaining({
          matchedText: 'since 2019, before 2024',
          dateFrom: '2019-01-01',
          dateTo: '2023-12-31',
        }),
      ]);
      expect(resultIds(response)).toEqual([11, 14]);
    });

    it.each(['crashes in 1899', 'crashes since 2101', 'crashes in 20234', 'crashes past 0 years'])(
      'leaves %p to be ranked by meaning, since it names no usable year',
      async (query) => {
        embedAs([1, 0]);

        const response = await searchDates(query);

        expect(embedded).toEqual([query]);
        expect(interpretationOf(response).constraints).toEqual([]);
      }
    );

    it('applies an explicit date range, without embedding an empty query', async () => {
      embedAs([1, 0]);

      const both = await searchDates('', { dateFrom: '2021-01-01', dateTo: '2023-12-31' });
      const fromOnly = await searchDates('', { dateFrom: '2024-01-01' });

      expect(embedded).toEqual([]);
      expect(interpretationOf(both).constraints).toEqual([
        {
          kind: 'DATE_RANGE',
          source: 'EXPLICIT_FILTER',
          matchedText: null,
          dateFrom: '2021-01-01',
          dateTo: '2023-12-31',
          incidentCount: 2,
          entities: [],
        },
      ]);
      expect(resultIds(both)).toEqual([11, 14]);
      expect(dateRanges(fromOnly)).toEqual([
        expect.objectContaining({ dateFrom: '2024-01-01', dateTo: null }),
      ]);
      expect(resultIds(fromOnly)).toEqual([15, 13]);
    });

    it('replaces an explicit date range with one typed in the query', async () => {
      embedAs([1, 0]);

      const response = await searchDates('incidents in 2018', { dateFrom: '2021-01-01' });
      const overInvalid = await searchDates('incidents in 2018', { dateTo: 'yesterday' });

      for (const replaced of [response, overInvalid]) {
        expect(interpretationOf(replaced).warnings).toEqual([]);
        expect(dateRanges(replaced)).toEqual([
          expect.objectContaining({
            source: 'QUERY_TEXT',
            dateFrom: '2018-01-01',
            dateTo: '2018-12-31',
          }),
        ]);
        expect(resultIds(replaced)).toEqual([10, 12]);
      }
    });

    it('reports each invalid date and applies any valid bound', async () => {
      embedAs([1, 0]);

      const invalid = await searchDates('', { dateFrom: '2021-02-30', dateTo: '2023/12/31' });
      const halfValid = await searchDates('', { dateFrom: '2023-01-01', dateTo: '2024-5-10' });

      expect(embedded).toEqual([]);
      expect(interpretationOf(invalid).warnings).toEqual([
        { code: 'INVALID_DATE', text: '2021-02-30' },
        { code: 'INVALID_DATE', text: '2023/12/31' },
      ]);
      expect(interpretationOf(invalid).constraints).toEqual([]);
      expect(invalid.body.data.semanticSearch).toMatchObject({ status: 'OK', results: [] });

      expect(interpretationOf(halfValid).warnings).toEqual([
        { code: 'INVALID_DATE', text: '2024-5-10' },
      ]);
      expect(resultIds(halfValid)).toEqual([15, 13, 11]);
    });

    it('combines a date range with exclusions and does not count it as an entity filter', async () => {
      embedAs([1, 0]);

      const excluded = await searchDates('', { excludeNames: ['tesla'], dateFrom: '2023-01-01' });

      // 11 is in range but Tesla's.
      expect(resultIds(excluded)).toEqual([15, 13]);

      const names = Array.from({ length: 20 }, (_, index) => `name-${index}`);
      const capped = await searchDates('crashes', {
        excludeNames: names,
        dateFrom: '2023-01-01',
        dateTo: '2024-12-31',
      });

      expect(capped.body.errors).toBeUndefined();
      expect(dateRanges(capped)).toHaveLength(1);
    });

    it('never matches an incident without a usable date', async () => {
      embedAs([1, 0]);

      await seedCollection({
        name: 'incidents',
        docs: [
          { ...incident(16, 'Undated incident', {}), date: undefined },
          { ...incident(17, 'Badly dated incident', {}), date: '2024' },
        ],
        drop: false,
      });

      const response = await searchDates('incidents since 1900');

      expect(resultIds(response)).toEqual([15, 13, 11, 14, 10, 12]);
      expect(dateRanges(response)[0].incidentCount).toBe(6);
    });

    it('offers the earliest and latest incident dates as facets', async () => {
      await seedCollection({
        name: 'incidents',
        docs: [{ ...incident(17, 'Badly dated incident', {}), date: '0' }],
        drop: false,
      });

      const response = await makeRequest(url, {
        query: `query { semanticSearchFacets { earliestDate latestDate } }`,
      });

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.semanticSearchFacets).toEqual({
        earliestDate: '2018-03-18',
        latestDate: '2024-05-10',
      });
    });
  });

  it('counts every incident above the minimum score before the limit', async () => {
    embedAs([1, 0]);

    const plain = await search('crashes', { limit: 2 });

    expect(resultIds(plain)).toEqual([10, 11]);
    expect(plain.body.data.semanticSearch.totalCount).toBe(5);

    const excluding = await search('crashes excluding tesla', { limit: 1 });

    expect(resultIds(excluding)).toEqual([12]);
    expect(excluding.body.data.semanticSearch.totalCount).toBe(3);
  });

  it('counts nothing when embedding is limited', async () => {
    stubEmbedding(async () => new Response('rate limited', { status: 429 }));

    const limited = await search('crashes');

    expect(limited.body.data.semanticSearch).toMatchObject({
      status: 'QUOTA_EXHAUSTED',
      totalCount: 0,
    });
  });

  describe('MIT risk domains', () => {
    const DOMAINS = [
      '1. Discrimination and Toxicity',
      '2. Privacy & Security',
      '3. Misinformation',
      '4. Malicious Actors & Misuse',
      '5. Human-Computer Interaction',
      '6. Socioeconomic & Environmental Harms',
      '7. AI system safety, failures, and limitations',
    ];

    const classification = (incidentId: number, domain: string, publish = true) => ({
      namespace: 'MIT',
      publish,
      incidents: [incidentId],
      attributes: [
        { short_name: 'Intent', value_json: JSON.stringify('2 - Unintentional') },
        { short_name: 'Risk Domain', value_json: JSON.stringify(domain) },
      ],
    });

    const searchMit = (
      query: string,
      filters: { excludeEntities?: string[]; excludeNames?: string[]; mitRiskDomains?: string[] }
    ) =>
      makeRequest(url, {
        query: `
          query SemanticSearch($query: String!, $filters: SemanticSearchFilters) {
            semanticSearch(query: $query, filters: $filters) {
              status
              totalCount
              results { score incident { incident_id } }
              interpretation {
                semanticText
                constraints {
                  kind
                  source
                  matchedText
                  mitRiskDomain
                  incidentCount
                  entities { entity_id }
                }
                warnings { code text }
                suggestions { kind value label }
              }
            }
          }
        `,
        variables: { query, filters },
      });

    const suggestionsOf = (response: any) => interpretationOf(response).suggestions;

    const suggestedValues = (response: any) =>
      suggestionsOf(response).map((suggestion: any) => suggestion.value);

    beforeEach(async () => {
      await seedCollection({
        name: 'taxa',
        docs: [
          {
            namespace: 'MIT',
            field_list: [
              { short_name: 'Intent', permitted_values: ['1 - Intentional', '2 - Unintentional'] },
              { short_name: 'Risk Domain', permitted_values: DOMAINS },
            ],
          },
          // Other taxonomies are never read.
          {
            namespace: 'CSETv1',
            field_list: [{ short_name: 'Risk Domain', permitted_values: ['Not MIT'] }],
          },
        ],
      });

      // 13 has only an unpublished classification and 15 only a CSETv1 one, so neither matches.
      await seedCollection({
        name: 'classifications',
        docs: [
          classification(10, DOMAINS[6]),
          classification(11, DOMAINS[6]),
          classification(12, DOMAINS[6]),
          classification(14, DOMAINS[1]),
          classification(13, DOMAINS[2], false),
          { ...classification(15, DOMAINS[2]), namespace: 'CSETv1' },
        ],
      });
    });

    it('keeps incidents with any of the domains and removes exclusions from them', async () => {
      embedAs([1, 0]);

      const response = await searchMit('crashes', {
        mitRiskDomains: [DOMAINS[6], DOMAINS[2]],
        excludeNames: ['tesla'],
      });

      expect(response.body.errors).toBeUndefined();
      expect(embedded).toEqual(['crashes']);
      expect(interpretationOf(response).constraints).toEqual([
        expect.objectContaining({ kind: 'EXCLUDE_ENTITY', mitRiskDomain: null }),
        {
          kind: 'MIT_RISK_DOMAIN',
          source: 'EXPLICIT_FILTER',
          matchedText: DOMAINS[6],
          mitRiskDomain: DOMAINS[6],
          incidentCount: 3,
          entities: [],
        },
        {
          kind: 'MIT_RISK_DOMAIN',
          source: 'EXPLICIT_FILTER',
          matchedText: DOMAINS[2],
          mitRiskDomain: DOMAINS[2],
          incidentCount: 0,
          entities: [],
        },
      ]);
      expect(resultIds(response)).toEqual([12]);
    });

    it('lists the incidents of the domains newest first when nothing else is asked', async () => {
      embedAs([1, 0]);

      const response = await searchMit('', { mitRiskDomains: [DOMAINS[1], DOMAINS[6]] });

      expect(response.body.errors).toBeUndefined();
      expect(embedded).toEqual([]);
      expect(interpretationOf(response).semanticText).toBe('');
      expect(resultIds(response)).toEqual([11, 14, 10, 12]);
      expect(response.body.data.semanticSearch.totalCount).toBe(4);
    });

    it('reports unknown values without applying them or counting them as entity filters', async () => {
      embedAs([1, 0]);

      const entityIds = Array.from({ length: 20 }, (_, index) => `entity-${index}`);

      const response = await searchMit('crashes', {
        excludeEntities: entityIds,
        mitRiskDomains: ['Misinformation', 'Not MIT', DOMAINS[1]],
      });

      expect(response.body.errors).toBeUndefined();
      expect(interpretationOf(response).warnings).toEqual([
        ...entityIds.map((text) => ({ code: 'UNKNOWN_ENTITY', text })),
        { code: 'UNKNOWN_MIT_DOMAIN', text: 'Misinformation' },
        { code: 'UNKNOWN_MIT_DOMAIN', text: 'Not MIT' },
      ]);
      expect(interpretationOf(response).constraints).toEqual([
        expect.objectContaining({ mitRiskDomain: DOMAINS[1], incidentCount: 1 }),
      ]);
      // 14 is the only incident in the domain, and it scores below the minimum.
      expect(resultIds(response)).toEqual([]);
    });

    it('suggests the domains a query names without filtering on them', async () => {
      embedAs([1, 0]);

      const response = await searchMit('Privacy failures and misinformation', {});

      expect(response.body.errors).toBeUndefined();
      expect(embedded).toEqual(['Privacy failures and misinformation']);
      expect(interpretationOf(response).constraints).toEqual([]);
      expect(suggestionsOf(response)).toEqual([
        { kind: 'MIT_RISK_DOMAIN', value: DOMAINS[1], label: 'Privacy & Security' },
        {
          kind: 'MIT_RISK_DOMAIN',
          value: DOMAINS[6],
          label: 'AI system safety, failures, and limitations',
        },
        { kind: 'MIT_RISK_DOMAIN', value: DOMAINS[2], label: 'Misinformation' },
      ]);
      expect(resultIds(response)).toEqual([10, 11, 12, 13, 15]);
    });

    it('suggests a domain only for a whole idea from its name, folding plurals', async () => {
      embedAs([1, 0]);

      const ideas = {
        // Everyday words from the names suggest nothing on their own.
        'an ai system harms actors in a human computer game': [],
        'safety of an ai system': [],
        'malicious actor deepfakes': [DOMAINS[3]],
        'human-computer interactions with chatbots': [DOMAINS[4]],
        'environmental harm from data centres': [DOMAINS[5]],
        'ai systems safety': [DOMAINS[6]],
      };

      for (const [query, expected] of Object.entries(ideas)) {
        const response = await searchMit(query, {});

        expect({ query, suggested: suggestedValues(response) }).toEqual({
          query,
          suggested: expected,
        });
      }
    });

    it('caps suggestions at three, skipping filtered domains and excluded words', async () => {
      embedAs([1, 0]);

      const query = 'discrimination, privacy, misinformation and misuse';

      expect(suggestedValues(await searchMit(query, {}))).toEqual(DOMAINS.slice(0, 3));
      expect(suggestedValues(await searchMit(query, { mitRiskDomains: [DOMAINS[0]] }))).toEqual(
        DOMAINS.slice(1, 4)
      );
      expect(suggestedValues(await searchMit('chatbots excluding misinformation', {}))).toEqual([]);
    });

    it('keeps incidents in any of the domains and in the date range, minus exclusions', async () => {
      embedAs([1, 0]);

      // The domains cover 10, 11, 12 and 14, and the dates 11, 13, 14 and 15. Of the 11 and 14
      // they share, 11 is Tesla's.
      const response = await searchMit('incidents since 2021 excluding tesla', {
        mitRiskDomains: [DOMAINS[6], DOMAINS[1]],
      });

      expect(response.body.errors).toBeUndefined();
      expect(embedded).toEqual([]);
      expect(
        interpretationOf(response).constraints.map((constraint: any) => constraint.kind)
      ).toEqual(['MIT_RISK_DOMAIN', 'MIT_RISK_DOMAIN', 'EXCLUDE_ENTITY', 'DATE_RANGE']);
      expect(resultIds(response)).toEqual([14]);
      expect(response.body.data.semanticSearch.totalCount).toBe(1);
    });

    it('lists the seven domains in the facets, in their numbered order', async () => {
      global.fetch = jest.fn();

      const response = await makeRequest(url, {
        query: `query SemanticSearchFacets { semanticSearchFacets { mitRiskDomains } }`,
      });

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.semanticSearchFacets.mitRiskDomains).toEqual(DOMAINS);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('linked entities', () => {
    const link = (sub: string, obj: string, is_symmetric = true) => ({
      sub,
      obj,
      is_symmetric,
      pred: 'related',
    });

    const seedLinks = (...links: ReturnType<typeof link>[]) =>
      seedCollection({ name: 'entity_relationships', docs: links });

    beforeEach(async () => {
      embedAs([1, 0]);

      await seedCollection({
        name: 'entities',
        docs: [
          { entity_id: 'meta', name: 'Meta' },
          { entity_id: 'facebook', name: 'Facebook' },
          { entity_id: 'instagram', name: 'Instagram' },
          { entity_id: 'mobileye', name: 'Mobileye' },
          {
            entity_id: 'people-recorded-by-smart-glasses',
            name: 'People recorded by smart glasses',
          },
        ],
        drop: false,
      });

      // Scores continue below incident 15: 20 > 21 > 22 > 23 > 24.
      await seedCollection({
        name: 'incidents',
        docs: [
          incident(20, 'Meta chatbot flirts with teenagers', { deployer: ['meta'] }),
          // Recorded before the rename, so only Facebook is tagged.
          incident(21, 'Facebook ads hide jobs from older people', { deployer: ['facebook'] }),
          incident(22, 'Instagram recommends harmful diets', { deployer: ['instagram'] }),
          incident(23, 'Camera misreads a speed sign', { developer: ['mobileye'] }),
          incident(24, 'Smart glasses identify strangers', {
            harmed: ['people-recorded-by-smart-glasses'],
          }),
        ],
        drop: false,
      });

      await seedCollection({
        name: 'incident_embeddings',
        docs: [
          vectors(20, [0.7, 0.71]),
          vectors(21, [0.6, 0.8]),
          vectors(22, [0.5, 0.87]),
          vectors(23, [0.4, 0.92]),
          vectors(24, [0.3, 0.95]),
        ],
        drop: false,
      });
    });

    it('keeps Facebook-only incidents when nothing links Meta and Facebook', async () => {
      const response = await search('social media harms excluding meta');

      expect(excludedIds(response)).toEqual([['meta']]);
      expect(resultIds(response)).toEqual([10, 11, 12, 13, 15, 21, 22, 23, 24]);
    });

    it('excludes the entities linked to a named one, following the link either way', async () => {
      await seedLinks(link('facebook', 'meta'));

      const meta = await search('social media harms excluding meta');

      expect(interpretationOf(meta).constraints).toEqual([
        {
          kind: 'EXCLUDE_ENTITY',
          source: 'QUERY_TEXT',
          matchedText: 'meta',
          incidentCount: 2,
          entities: [
            { entity_id: 'meta', name: 'Meta', matchedBy: 'NAME' },
            { entity_id: 'facebook', name: 'Facebook', matchedBy: 'LINK' },
          ],
        },
      ]);
      expect(resultIds(meta)).toEqual([10, 11, 12, 13, 15, 22, 23, 24]);

      const facebook = await search('social media harms excluding facebook');

      expect(interpretationOf(facebook).constraints[0].entities).toEqual([
        { entity_id: 'facebook', name: 'Facebook', matchedBy: 'NAME' },
        { entity_id: 'meta', name: 'Meta', matchedBy: 'LINK' },
      ]);
      expect(resultIds(facebook)).toEqual([10, 11, 12, 13, 15, 22, 23, 24]);
      expect(embedded).toEqual(['social media harms', 'social media harms']);
    });

    it('follows one link and no further', async () => {
      await seedLinks(link('meta', 'facebook'), link('facebook', 'instagram'));

      const response = await search('social media harms excluding meta');

      expect(excludedIds(response)).toEqual([['meta', 'facebook']]);
      expect(resultIds(response)).toEqual([10, 11, 12, 13, 15, 22, 23, 24]);
    });

    it('follows links from the named entity only and lists linked entities last', async () => {
      // As in the real data, a Meta-family entity is linked to Meta and also to every scammer.
      await seedCollection({
        name: 'entities',
        docs: [
          {
            entity_id: 'unknown-scammers-operating-meta-ad-accounts',
            name: 'Unknown scammers operating Meta ad accounts',
          },
          { entity_id: 'scammers', name: 'Scammers' },
        ],
        drop: false,
      });
      await seedCollection({
        name: 'incidents',
        docs: [
          incident(25, 'Fake Meta ads sell a bogus investment', {
            deployer: ['unknown-scammers-operating-meta-ad-accounts'],
          }),
          incident(26, 'Voice clone scams a grandmother', { deployer: ['scammers'] }),
        ],
        drop: false,
      });
      await seedCollection({
        name: 'incident_embeddings',
        docs: [vectors(25, [0.25, 0.97]), vectors(26, [0.2, 0.98])],
        drop: false,
      });
      await seedLinks(
        link('facebook', 'meta'),
        link('unknown-scammers-operating-meta-ad-accounts', 'meta'),
        link('unknown-scammers-operating-meta-ad-accounts', 'scammers')
      );

      const response = await search('social media harms excluding meta');

      expect(interpretationOf(response).constraints[0]).toMatchObject({
        incidentCount: 3,
        entities: [
          { entity_id: 'meta', name: 'Meta', matchedBy: 'NAME' },
          {
            entity_id: 'unknown-scammers-operating-meta-ad-accounts',
            name: 'Unknown scammers operating Meta ad accounts',
            matchedBy: 'FAMILY',
          },
          { entity_id: 'facebook', name: 'Facebook', matchedBy: 'LINK' },
        ],
      });
      expect(resultIds(response)).toEqual([10, 11, 12, 13, 15, 22, 23, 24, 26]);
    });

    it('adds nothing for a linked entity that is never responsible for an incident', async () => {
      await seedLinks(link('meta', 'people-recorded-by-smart-glasses'));

      const response = await search('social media harms excluding meta');

      expect(excludedIds(response)).toEqual([['meta']]);
      expect(interpretationOf(response).constraints[0].incidentCount).toBe(1);
      expect(resultIds(response)).toEqual([10, 11, 12, 13, 15, 21, 22, 23, 24]);
    });

    it('follows a link marked as not symmetric from sub to obj only', async () => {
      await seedLinks(link('instagram', 'meta', false));

      expect(excludedIds(await search('social media harms excluding instagram'))).toEqual([
        ['instagram', 'meta'],
      ]);
      expect(excludedIds(await search('social media harms excluding meta'))).toEqual([['meta']]);
    });

    it('keeps links until the cache is reset, then follows new ones', async () => {
      expect(excludedIds(await search('social media harms excluding meta'))).toEqual([['meta']]);

      await seedLinks(link('facebook', 'meta'));

      expect(excludedIds(await search('social media harms excluding meta'))).toEqual([['meta']]);

      resetSemanticSearchCache();

      const response = await search('social media harms excluding meta');

      expect(excludedIds(response)).toEqual([['meta', 'facebook']]);
      expect(resultIds(response)).toEqual([10, 11, 12, 13, 15, 22, 23, 24]);
    });
  });

  describe('inclusions and affected parties', () => {
    const RESPONSIBLE = ['DEPLOYER', 'DEVELOPER', 'IMPLICATED'];

    const searchFor = (
      query: string,
      variables: { limit?: number; filters?: Record<string, unknown> } = {}
    ) =>
      makeRequest(url, {
        query: `
          query SemanticSearch($query: String!, $limit: Int, $filters: SemanticSearchFilters) {
            semanticSearch(query: $query, limit: $limit, filters: $filters) {
              status
              totalCount
              results { score incident { incident_id } }
              interpretation {
                semanticText
                constraints {
                  kind
                  source
                  matchedText
                  roles
                  mitRiskDomain
                  dateFrom
                  dateTo
                  incidentCount
                  entities { entity_id name matchedBy }
                }
                warnings { code text }
                suggestions { kind value label }
              }
            }
          }
        `,
        variables: { query, ...variables },
      });

    const constraintsOf = (response: any) =>
      interpretationOf(response).constraints.map(({ kind, source, matchedText, roles }: any) => ({
        kind,
        source,
        matchedText,
        roles,
      }));

    const suggestionsOf = (response: any) =>
      interpretationOf(response).suggestions.map(({ value }: any) => value);

    beforeEach(async () => {
      embedAs([1, 0]);

      // Without MIT domains, so words like "failures" suggest nothing, whatever ran before.
      await seedCollection({ name: 'taxa', docs: [] });
      await seedCollection({ name: 'classifications', docs: [] });

      await seedCollection({
        name: 'entities',
        docs: [
          { entity_id: 'google', name: 'Google' },
          { entity_id: 'openai', name: 'OpenAI' },
          { entity_id: 'university-students', name: 'University students' },
          { entity_id: 'saferent', name: 'SafeRent' },
          { entity_id: 'low-income-tenants', name: 'Low-income tenants' },
          { entity_id: 'economically-vulnerable-people', name: 'Economically vulnerable people' },
          // Contrived, so that reading "from 2023" as an inclusion would find something.
          { entity_id: '2023', name: '2023' },
        ],
        drop: false,
      });

      // Scores continue below incident 15: 40 > 41 > 42 > 43 > 44. Newest first: 41, 40, 42, 43, 44.
      await seedCollection({
        name: 'incidents',
        docs: [
          {
            ...incident(40, 'Google chatbot misleads university students', {
              developer: ['google'],
              harmed: ['university-students'],
            }),
            date: '2022-01-01',
          },
          {
            ...incident(41, 'Google proctoring flags students', {
              deployer: ['google'],
              harmed: ['students'],
            }),
            date: '2023-01-01',
          },
          {
            ...incident(42, 'Essay detector fails students', {
              developer: ['openai'],
              harmed: ['students'],
            }),
            date: '2021-01-01',
          },
          {
            ...incident(43, 'Screening tool rejects tenants', {
              deployer: ['saferent'],
              harmed: ['low-income-tenants'],
            }),
            date: '2020-01-01',
          },
          {
            ...incident(44, 'Benefits algorithm cuts payments', {
              deployer: ['2023'],
              harmed: ['economically-vulnerable-people'],
            }),
            date: '2019-01-01',
          },
        ],
        drop: false,
      });

      await seedCollection({
        name: 'incident_embeddings',
        docs: [
          vectors(40, [0.75, 0.66]),
          vectors(41, [0.7, 0.71]),
          vectors(42, [0.65, 0.76]),
          vectors(43, [0.6, 0.8]),
          vectors(44, [0.55, 0.84]),
        ],
        drop: false,
      });
    });

    it.each(['by', 'from', 'involving', 'involves'])(
      'keeps only incidents an organisation is responsible for after "%s"',
      async (word) => {
        const response = await searchFor(`chatbot failures ${word} google`);

        expect(response.body.errors).toBeUndefined();
        expect(embedded).toEqual(['chatbot failures']);
        expect(resultIds(response)).toEqual([40, 41]);
        expect(interpretationOf(response)).toMatchObject({
          semanticText: 'chatbot failures',
          warnings: [],
          suggestions: [],
          constraints: [
            {
              kind: 'INCLUDE_ENTITY',
              source: 'QUERY_TEXT',
              matchedText: 'google',
              roles: RESPONSIBLE,
              incidentCount: 2,
              entities: [{ entity_id: 'google', name: 'Google', matchedBy: 'NAME' }],
            },
          ],
        });
      }
    );

    it.each([
      ['developed by', 'DEVELOPER', [40]],
      ['made by', 'DEVELOPER', [40]],
      ['built by', 'DEVELOPER', [40]],
      ['deployed by', 'DEPLOYER', [41]],
      ['used by', 'DEPLOYER', [41]],
      ['operated by', 'DEPLOYER', [41]],
    ])('restricts an inclusion after "%s" to the %s role', async (phrase, role, ids) => {
      const response = await searchFor(`chatbots ${phrase} Google`);

      expect(embedded).toEqual(['chatbots']);
      expect(constraintsOf(response)).toEqual([
        { kind: 'INCLUDE_ENTITY', source: 'QUERY_TEXT', matchedText: 'Google', roles: [role] },
      ]);
      expect(resultIds(response)).toEqual(ids);
    });

    it.each(['affecting', 'harming', 'targeting', 'against'])(
      'keeps only incidents a group and groups named after it were harmed in, after "%s"',
      async (word) => {
        const response = await searchFor(`incidents ${word} students`);

        expect(embedded).toEqual([]);
        expect(interpretationOf(response)).toMatchObject({
          semanticText: '',
          constraints: [
            {
              kind: 'HARMED_PARTY',
              source: 'QUERY_TEXT',
              matchedText: 'students',
              roles: ['HARMED'],
              incidentCount: 3,
              // Students deploy a chatbot in incident 15, which is not being harmed.
              entities: [
                { entity_id: 'students', name: 'Students', matchedBy: 'NAME' },
                {
                  entity_id: 'university-students',
                  name: 'University students',
                  matchedBy: 'FAMILY',
                },
              ],
            },
          ],
        });
        expect(resultIds(response)).toEqual([41, 40, 42]);
      }
    );

    it('follows links between harmed groups', async () => {
      await seedCollection({
        name: 'entity_relationships',
        docs: [
          {
            sub: 'low-income-tenants',
            obj: 'economically-vulnerable-people',
            is_symmetric: true,
            pred: 'related',
          },
        ],
      });

      const response = await searchFor('incidents affecting low-income tenants');

      expect(excludedIds(response)).toEqual([
        ['low-income-tenants', 'economically-vulnerable-people'],
      ]);
      expect(resultIds(response)).toEqual([43, 44]);
    });

    it('means any of the same kind, all of different kinds, and applies exclusions last', async () => {
      const either = await searchFor('failures by google and openai');
      const both = await searchFor('failures by google affecting students');
      const byRole = await searchFor('failures developed by google, deployed by google');
      const excluding = await searchFor('failures affecting students excluding openai');

      expect(constraintsOf(either).map(({ matchedText }: any) => matchedText)).toEqual([
        'google',
        'openai',
      ]);
      expect(resultIds(either)).toEqual([40, 41, 42]);
      expect(resultIds(both)).toEqual([40, 41]);
      expect(constraintsOf(byRole).map(({ roles }: any) => roles)).toEqual([
        ['DEVELOPER'],
        ['DEPLOYER'],
      ]);
      expect(resultIds(byRole)).toEqual([]);
      expect(resultIds(excluding)).toEqual([40, 41]);
      expect(embedded).toEqual(['failures', 'failures', 'failures', 'failures']);
    });

    it('keeps only incidents that satisfy every group, with exclusions applied last', async () => {
      const clock = jest
        .spyOn(semanticSearchClock, 'now')
        .mockReturnValue(new Date('2024-07-15T12:00:00Z'));

      try {
        const MISINFORMATION = '3. Misinformation';
        const PRIVACY = '2. Privacy & Security';

        const classification = (incidentId: number, domain: string) => ({
          namespace: 'MIT',
          publish: true,
          incidents: [incidentId],
          attributes: [{ short_name: 'Risk Domain', value_json: JSON.stringify(domain) }],
        });

        await seedCollection({
          name: 'taxa',
          docs: [
            {
              namespace: 'MIT',
              field_list: [
                { short_name: 'Risk Domain', permitted_values: [PRIVACY, MISINFORMATION] },
              ],
            },
          ],
        });

        // Each of 45 to 49 fails exactly one requirement and passes the rest. 40 and 41 pass all.
        await seedCollection({
          name: 'incidents',
          docs: [
            {
              ...incident(45, 'Wrong MIT domain', { deployer: ['google'], harmed: ['students'] }),
              date: '2023-03-01',
            },
            {
              ...incident(46, 'Too old', { deployer: ['google'], harmed: ['students'] }),
              date: '2019-03-01',
            },
            {
              ...incident(47, 'Excluded organisation', {
                deployer: ['google'],
                developer: ['openai'],
                harmed: ['students'],
              }),
              date: '2023-03-01',
            },
            {
              ...incident(48, 'Not Google', { deployer: ['uber'], harmed: ['students'] }),
              date: '2023-03-01',
            },
            {
              ...incident(49, 'Other harmed party', {
                deployer: ['google'],
                harmed: ['low-income-tenants'],
              }),
              date: '2023-03-01',
            },
          ],
          drop: false,
        });
        await seedCollection({
          name: 'classifications',
          docs: [
            classification(40, MISINFORMATION),
            classification(41, MISINFORMATION),
            classification(42, MISINFORMATION),
            classification(45, PRIVACY),
            classification(46, MISINFORMATION),
            classification(47, MISINFORMATION),
            classification(48, MISINFORMATION),
            classification(49, MISINFORMATION),
          ],
        });
        await seedCollection({
          name: 'incident_embeddings',
          docs: [45, 46, 47, 48, 49].map((id) => vectors(id, [0.5, 0.86])),
          drop: false,
        });

        const response = await searchFor(
          'chatbot failures by google affecting students since 2022 excluding openai',
          { filters: { mitRiskDomains: [MISINFORMATION] } }
        );

        expect(response.body.errors).toBeUndefined();
        expect(embedded).toEqual(['chatbot failures']);
        expect(
          interpretationOf(response).constraints.map((constraint: any) => [
            constraint.kind,
            constraint.incidentCount > 0,
          ])
        ).toEqual([
          ['MIT_RISK_DOMAIN', true],
          ['INCLUDE_ENTITY', true],
          ['HARMED_PARTY', true],
          ['EXCLUDE_ENTITY', true],
          ['DATE_RANGE', true],
        ]);
        expect(resultIds(response)).toEqual([40, 41]);
        expect(response.body.data.semanticSearch.totalCount).toBe(2);
      } finally {
        clock.mockRestore();
      }
    });

    it('leaves an unknown inclusion in the text exactly as written, without a warning', async () => {
      const unknown = await searchFor('failures by acme robotics');
      // Students never develop anything, and the "by" is not read again on its own.
      const wrongRole = await searchFor('chatbots developed by students');

      for (const response of [unknown, wrongRole]) {
        expect(interpretationOf(response).constraints).toEqual([]);
        expect(interpretationOf(response).warnings).toEqual([]);
      }

      // A name left alone after a linking word is not offered as a suggestion either.
      expect(interpretationOf(wrongRole).suggestions).toEqual([]);

      expect(embedded).toEqual(['failures by acme robotics', 'chatbots developed by students']);
    });

    it('reads "from" before a year as a date, never as an inclusion', async () => {
      // An entity is named "2023" and is responsible for incident 44, so an inclusion would find it.
      const response = await searchFor('robot failures from 2023');

      expect(constraintsOf(response).map(({ kind }: any) => kind)).toEqual(['DATE_RANGE']);
      expect(embedded).toEqual(['robot failures']);
      expect(resultIds(response)).toEqual([11, 13, 15, 41]);
    });

    it('suggests up to three plain mentions of responsible entities, until one is applied', async () => {
      const query = 'google chatbot misleads students about tesla autopilot and openai';

      const mentioned = await searchFor(query);

      expect(embedded).toEqual([query]);
      expect(interpretationOf(mentioned).constraints).toEqual([]);
      expect(interpretationOf(mentioned).suggestions).toEqual([
        { kind: 'INCLUDE_ENTITY', value: 'google', label: 'Google' },
        { kind: 'INCLUDE_ENTITY', value: 'students', label: 'Students' },
        { kind: 'INCLUDE_ENTITY', value: 'tesla-autopilot', label: 'Tesla Autopilot' },
      ]);

      const accepted = await searchFor(query, { filters: { include: [{ entityId: 'google' }] } });

      expect(embedded).toEqual([query, query]);
      expect(constraintsOf(accepted)).toEqual([
        {
          kind: 'INCLUDE_ENTITY',
          source: 'EXPLICIT_FILTER',
          matchedText: 'google',
          roles: RESPONSIBLE,
        },
      ]);
      expect(suggestionsOf(accepted)).toEqual(['students', 'tesla-autopilot', 'openai']);
      expect(resultIds(accepted)).toEqual([40, 41]);

      // Tesla drivers are only ever harmed, so only the Tesla in their name is offered.
      expect(suggestionsOf(await searchFor('crashes hurting tesla drivers'))).toEqual(['tesla']);
      expect(suggestionsOf(await searchFor('crashes excluding tesla, like tesla'))).toEqual([]);
    });

    it('reads each inclusion again from its matched text and roles, as the page sends them back', async () => {
      const typed = await searchFor('chatbot failures developed by google affecting students');
      const { semanticText, constraints } = interpretationOf(typed);

      expect(resultIds(typed)).toEqual([40]);

      const held = await searchFor(semanticText, {
        filters: {
          include: constraints.map(({ matchedText, roles }: any) => ({ name: matchedText, roles })),
        },
      });

      expect(embedded).toEqual(['chatbot failures', 'chatbot failures']);
      expect(interpretationOf(held)).toEqual({
        ...interpretationOf(typed),
        constraints: constraints.map((constraint: any) => ({
          ...constraint,
          source: 'EXPLICIT_FILTER',
        })),
      });
      expect(resultIds(held)).toEqual([40]);
    });

    it('takes included ids with roles, and reports ids and names it cannot apply', async () => {
      const picked = await searchFor('', {
        filters: {
          include: [
            { entityId: 'students', roles: ['HARMED'] },
            { entityId: 'google' },
            { entityId: 'google', roles: ['IMPLICATED', 'DEPLOYER', 'DEVELOPER'] },
          ],
        },
      });

      expect(embedded).toEqual([]);
      expect(constraintsOf(picked)).toEqual([
        {
          kind: 'HARMED_PARTY',
          source: 'EXPLICIT_FILTER',
          matchedText: 'students',
          roles: ['HARMED'],
        },
        {
          kind: 'INCLUDE_ENTITY',
          source: 'EXPLICIT_FILTER',
          matchedText: 'google',
          roles: RESPONSIBLE,
        },
      ]);
      expect(resultIds(picked)).toEqual([41, 40]);

      const unknown = await searchFor('crashes', {
        filters: {
          include: [
            { entityId: 'no-such-entity' },
            { name: 'acme robotics' },
            { entityId: 'tesla-drivers' },
            { entityId: 'tesla-drivers', roles: ['HARMED'] },
          ],
        },
      });

      expect(interpretationOf(unknown).warnings).toEqual([
        { code: 'UNKNOWN_ENTITY', text: 'no-such-entity' },
        { code: 'UNRECOGNISED_INCLUSION', text: 'acme robotics' },
        // Tesla drivers are only ever harmed, so nothing is found for them in responsible roles.
        { code: 'UNKNOWN_ENTITY', text: 'tesla-drivers' },
      ]);
      expect(constraintsOf(unknown)).toEqual([
        {
          kind: 'HARMED_PARTY',
          source: 'EXPLICIT_FILTER',
          matchedText: 'tesla-drivers',
          roles: ['HARMED'],
        },
      ]);
      expect(resultIds(unknown)).toEqual([13]);
    });

    it.each([
      [{ entityId: 'google', name: 'Google' }, 'exactly one of entityId and name'],
      [{ roles: ['DEVELOPER'] }, 'exactly one of entityId and name'],
      [{ name: 'students', roles: ['HARMED', 'DEVELOPER'] }, 'HARMED role cannot be combined'],
    ])('refuses an include filter it cannot read: %j', async (filter, message) => {
      const response = await searchFor('crashes', { filters: { include: [filter] } });

      expect(response.body.data).toBeNull();
      expect(response.body.errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining(message),
          extensions: expect.objectContaining({ code: 'BAD_USER_INPUT' }),
        }),
      ]);
      expect(embedded).toEqual([]);
    });

    it('counts inclusions towards the limit of 20 entity filters', async () => {
      const include = Array.from({ length: 11 }, (_, index) => ({ entityId: `entity-${index}` }));

      const refused = await searchFor('crashes', {
        filters: {
          excludeNames: Array.from({ length: 10 }, (_, index) => `name-${index}`),
          include,
        },
      });

      expect(refused.body.errors).toEqual([
        expect.objectContaining({
          message: 'A search takes at most 20 entity filters, but 21 were given.',
        }),
      ]);
    });

    it('lists every named harmed party as a facet', async () => {
      const response = await makeRequest(url, {
        query: `
          query SemanticSearchFacets {
            semanticSearchFacets {
              harmedEntities { entity_id name }
            }
          }
        `,
      });

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.semanticSearchFacets.harmedEntities).toEqual([
        { entity_id: 'economically-vulnerable-people', name: 'Economically vulnerable people' },
        { entity_id: 'low-income-tenants', name: 'Low-income tenants' },
        { entity_id: 'students', name: 'Students' },
        { entity_id: 'tesla-drivers', name: 'Tesla drivers' },
        { entity_id: 'university-students', name: 'University students' },
      ]);
    });
  });
});
