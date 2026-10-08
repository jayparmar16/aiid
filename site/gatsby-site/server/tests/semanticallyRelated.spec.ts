import { Binary, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createSemanticallyRelatedHandler } from '../../netlify/functions/semanticallyRelated';
import { getEmbeddingIndexConfig } from '../../src/utils/embeddings/config';
import { createEmbeddingProvider } from '../../src/utils/embeddings/provider';

jest.mock('../../sentry-instrumentation', () => ({ withSentry: (handler: unknown) => handler }));
jest.mock('@sentry/aws-serverless', () => ({ captureException: jest.fn() }));

const binary = (values: number[]) => Binary.fromFloat32Array(Float32Array.from(values));
const embedded = (vectors: number[][]) =>
  new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    }),
    { status: 200 }
  );

describe('schema-v2 suggestion endpoint', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let handler: ReturnType<typeof createSemanticallyRelatedHandler>;
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
  }, 60000);
  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });
  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      EMBEDDING_API_KEY: 'test-key',
      EMBEDDING_API_BASE_URL: 'https://embedding.test/v1',
      EMBEDDING_MODEL: 'nvidia/nemotron-3-embed-1b:free',
      EMBEDDING_MAX_INPUT_CHARS: '100',
      EMBEDDING_CHUNK_OVERLAP_CHARS: '10',
      EMBEDDING_BATCH_SIZE: '2',
    };
    handler = createSemanticallyRelatedHandler(() => client);
    global.fetch = jest
      .fn()
      .mockImplementation(async (_url, options) =>
        embedded(JSON.parse(options.body).input.map(() => [1, 0]))
      );
    const index = getEmbeddingIndexConfig(createEmbeddingProvider());
    const row = (id: number, overview: number[], passages: number[][]) => ({
      incident_id: id,
      embedding_schema_version: 2,
      embedding_profile: index.profileId,
      model: index.model,
      base_url: index.baseUrl,
      index_signature: index.indexSignature,
      dims: 2,
      overview: { vector: binary(overview) },
      passages: passages.map((vector) => ({ vector: binary(vector) })),
    });
    const db = client.db('aiidprod');
    await db.collection('incidents').deleteMany({});
    await db.collection('incident_embeddings').deleteMany({});
    await db
      .collection('incidents')
      .insertMany(Array.from({ length: 9 }, (_, i) => ({ incident_id: i + 1 })));
    await db
      .collection('incident_embeddings')
      .insertMany([
        row(1, [1, 0], [[1, 0]]),
        row(2, [0.6, 0.8], [[1, 0]]),
        row(3, [0, 1], [[1, 0]]),
        row(4, [0.8, 0.6], []),
        row(5, [0, 1], [[0, 1]]),
        { ...row(6, [1, 0], []), embedding_schema_version: 1 },
        { ...row(7, [1, 0], []), base_url: 'https://other.test/v1' },
        { ...row(8, [1, 0], []), model: 'other-model' },
        { ...row(9, [1, 0], []), index_signature: 'other-signature' },
        row(99, [1, 0], []),
      ]);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  const invoke = async (body: unknown = { text: 'A description' }) => {
    const result = await handler({
      httpMethod: 'POST',
      body: JSON.stringify(body),
      isBase64Encoded: false,
    });
    return { status: result.statusCode, body: JSON.parse(result.body as string) };
  };

  it('returns the top three compatible, current incidents without a legacy embedding', async () => {
    const result = await invoke();
    expect(result.status).toBe(200);
    expect(result.body.embedding).toBeNull();
    expect(result.body.incidents.map((row: any) => row.incident_id)).toEqual([1, 4, 2]);
    expect(result.body.incidents[2].similarity).toBeCloseTo(0.74);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://embedding.test/v1/embeddings');
    expect(JSON.parse(options.body).input_type).toBe('query');
  });

  it('preserves result-count conventions and excludes the edited incident before limiting', async () => {
    expect(
      (await invoke({ text: 'description', num: -1 })).body.incidents.map(
        (row: any) => row.incident_id
      )
    ).toEqual([1, 4, 2, 3]);
    expect((await invoke({ text: 'description', num: '1' })).body.incidents).toHaveLength(1);
    expect((await invoke({ text: 'description', num: 0 })).body.incidents).toHaveLength(3);
    expect(
      (await invoke({ text: 'description', excludeIncidentId: 1 })).body.incidents.map(
        (row: any) => row.incident_id
      )
    ).toEqual([4, 2, 3]);
  });

  it('processes the tail of long text in bounded batches and keeps each incident’s strongest score', async () => {
    global.fetch = jest
      .fn()
      .mockImplementation(async (_url, options) =>
        embedded(
          JSON.parse(options.body).input.map((text: string) =>
            text.includes('TAIL_FACT') ? [0, 1] : [1, 0]
          )
        )
      );
    const result = await invoke({
      text: `${'Early article details. '.repeat(35)}TAIL_FACT`,
      num: -1,
    });
    expect(result.status).toBe(200);
    expect(result.body.incidents.map((row: any) => row.incident_id)).toContain(5);
    expect(result.body.incidents.find((row: any) => row.incident_id === 5).similarity).toBeCloseTo(
      1
    );
    const inputs = (global.fetch as jest.Mock).mock.calls.map(
      ([_url, options]) => JSON.parse(options.body).input as string[]
    );
    expect(inputs.length).toBeGreaterThan(1);
    expect(
      inputs.every((batch) => batch.length <= 2 && batch.every((text) => text.length <= 100))
    ).toBe(true);
    expect(inputs.flat().join('')).toContain('TAIL_FACT');
  });

  it('keeps the warm corpus for ten minutes and never returns a deleted incident', async () => {
    await invoke();
    await client
      .db('aiidprod')
      .collection('incident_embeddings')
      .updateOne(
        { incident_id: 1 },
        { $set: { 'overview.vector': binary([-1, 0]), passages: [] } }
      );
    expect((await invoke()).body.incidents[0].incident_id).toBe(1);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 600001);
    expect((await invoke()).body.incidents[0].incident_id).toBe(4);
    await client.db('aiidprod').collection('incidents').deleteOne({ incident_id: 4 });
    expect((await invoke()).body.incidents.map((row: any) => row.incident_id)).not.toContain(4);
  });

  it('returns an empty match list for unrelated input and skips all dependencies when disabled', async () => {
    global.fetch = jest.fn().mockResolvedValue(embedded([[-1, 0]]));
    expect(await invoke()).toEqual({ status: 200, body: { embedding: null, incidents: [] } });
    const disabled = createSemanticallyRelatedHandler(() => {
      throw new Error('must not access MongoDB');
    });
    global.fetch = jest.fn();
    const result = await disabled({
      httpMethod: 'POST',
      isBase64Encoded: false,
      body: JSON.stringify({ text: 'description', includeSimilar: false }),
    });
    expect(JSON.parse(result.body as string)).toEqual({ embedding: null, incidents: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    null,
    { text: ' ' },
    { text: 1 },
    { text: 'text', num: 1.5 },
    { text: 'text', num: [] },
    { text: 'text', excludeIncidentId: -1 },
    { text: 'text', includeSimilar: 'no' },
  ])('rejects invalid input %j before embedding', async (body) => {
    expect((await invoke(body)).status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('handles malformed JSON, base64 bodies, and unsupported methods', async () => {
    const invalid = await handler({ httpMethod: 'POST', body: '{', isBase64Encoded: false });
    expect(invalid.statusCode).toBe(400);
    expect(
      (await handler({ httpMethod: 'GET', body: null, isBase64Encoded: false })).statusCode
    ).toBe(405);
    expect(
      (
        await handler({
          httpMethod: 'POST',
          body: Buffer.from(JSON.stringify({ text: 'description' })).toString('base64'),
          isBase64Encoded: true,
        })
      ).statusCode
    ).toBe(200);
  });

  it('maps quota exhaustion to 429 without honoring caller retries', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('limited', { status: 429 }));
    expect((await invoke({ text: 'description', max_retries: 6 })).status).toBe(429);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('maps missing configuration, incompatible corpus, and malformed provider responses to 503', async () => {
    delete process.env.EMBEDDING_API_KEY;
    expect((await invoke()).status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
    process.env.EMBEDDING_API_KEY = 'test-key';
    process.env.EMBEDDING_MODEL = 'other-model';
    expect((await invoke()).status).toBe(503);
    process.env.EMBEDDING_MODEL = 'nvidia/nemotron-3-embed-1b:free';
    global.fetch = jest.fn().mockResolvedValue(embedded([[NaN, 0]]));
    expect((await invoke()).status).toBe(503);
  });

  it('rejects inconsistent dimensions between query batches', async () => {
    process.env.EMBEDDING_BATCH_SIZE = '1';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(embedded([[1, 0]]))
      .mockResolvedValue(embedded([[1, 0, 0]]));
    expect((await invoke({ text: 'long article '.repeat(30) })).status).toBe(503);
  });

  it('returns 503 when the database cannot be read, without exposing connection errors', async () => {
    const unavailable = createSemanticallyRelatedHandler(() => {
      throw new Error('private database connection details');
    });
    const result = await unavailable({
      httpMethod: 'POST',
      body: JSON.stringify({ text: 'description' }),
      isBase64Encoded: false,
    });
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body as string)).toEqual({ error: 'Similarity is unavailable' });
  });

  it('aborts an embedding request after eight seconds', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn().mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
        })
    );
    const result = invoke();
    await jest.advanceTimersByTimeAsync(8000);
    expect((await result).status).toBe(503);
    expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('aborts a multi-batch request at the sixty-second overall deadline', async () => {
    process.env.EMBEDDING_BATCH_SIZE = '1';
    await invoke(); // Warm the corpus before advancing virtual time.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    global.fetch = jest.fn().mockImplementation(
      (_url, { signal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(embedded([[1, 0]])), 7000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        })
    );
    const result = invoke({ text: 'long article '.repeat(100) });
    await jest.advanceTimersByTimeAsync(60000);
    expect((await result).status).toBe(503);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[calls.length - 1][1].signal.aborted).toBe(true);
  });
});
