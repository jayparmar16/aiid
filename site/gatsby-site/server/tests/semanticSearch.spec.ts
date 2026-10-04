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

    await seedCollection({ name: 'entity_relationships', docs: [] });

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
});
