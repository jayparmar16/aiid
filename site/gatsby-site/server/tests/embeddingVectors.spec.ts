import { Binary, type MongoClient } from 'mongodb';
import {
  getEmbeddingIndexConfig,
  type EmbeddingIndexConfig,
} from '../../src/utils/embeddings/config';
import {
  createIncidentVectorLoader,
  normaliseBinaryVector,
  rankIncidentVectors,
} from '../../src/utils/embeddings/vectors';

const profile = {
  model: 'nvidia/nemotron-3-embed-1b:free',
  baseUrl: 'https://openrouter.ai/api/v1',
  profileId: 'nemotron-retrieval-v1',
};
const binary = (values: number[]) => Binary.fromFloat32Array(Float32Array.from(values));

describe('shared embedding index configuration', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.EMBEDDING_MAX_INPUT_CHARS;
    delete process.env.EMBEDDING_CHUNK_OVERLAP_CHARS;
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('preserves the existing schema-v2 signature and chunk defaults', () => {
    expect(getEmbeddingIndexConfig(profile)).toEqual({
      ...profile,
      maxInputChars: 8000,
      overlapChars: 200,
      indexSignature: 'c5976926582d55e3c211a9bf128d6159099773d5032c64f700dfb2c32d374322',
    });
  });

  it('invalidates a signature when the model, endpoint, profile, or chunk settings change', () => {
    const initial = getEmbeddingIndexConfig(profile).indexSignature;
    for (const change of [
      { model: 'vendor/other-model' },
      { baseUrl: 'https://provider.test/v1' },
      { profileId: 'openai-compatible-v1' },
    ]) {
      expect(getEmbeddingIndexConfig({ ...profile, ...change }).indexSignature).not.toBe(initial);
    }
    process.env.EMBEDDING_MAX_INPUT_CHARS = '4000';
    expect(getEmbeddingIndexConfig(profile).indexSignature).not.toBe(initial);
    delete process.env.EMBEDDING_MAX_INPUT_CHARS;
    process.env.EMBEDDING_CHUNK_OVERLAP_CHARS = '100';
    expect(getEmbeddingIndexConfig(profile).indexSignature).not.toBe(initial);
  });

  it('rejects invalid budgets and overlap', () => {
    process.env.EMBEDDING_MAX_INPUT_CHARS = '-1';
    expect(() => getEmbeddingIndexConfig(profile)).toThrow('positive integer');
    process.env.EMBEDDING_MAX_INPUT_CHARS = '200';
    expect(() => getEmbeddingIndexConfig(profile)).toThrow('must be smaller');
  });
});

describe('shared vector decoding and ranking', () => {
  it('normalizes a copy of BSON Float32 data and rejects incompatible or malformed vectors', () => {
    const stored = binary([3, 4]);
    expect(Array.from(normaliseBinaryVector(stored, 2)!)).toEqual([
      0.6000000238418579, 0.800000011920929,
    ]);
    expect(Array.from(stored.toFloat32Array())).toEqual([3, 4]);
    for (const value of [
      binary([0, 0]),
      binary([NaN, 1]),
      binary([Infinity, 1]),
      binary([1]),
      new Binary(Buffer.from([1, 2])),
      [1, 2],
    ]) {
      expect(normaliseBinaryVector(value, 2)).toBeNull();
    }
  });

  it('weights the overview and best passage, applies the threshold, and limits the results', () => {
    const incidents = [
      { incidentId: 1, overview: Float32Array.from([1, 0]), passages: [Float32Array.from([0, 1])] },
      {
        incidentId: 2,
        overview: Float32Array.from([0.6, 0.8]),
        passages: [Float32Array.from([0, 1]), Float32Array.from([1, 0])],
      },
      { incidentId: 3, overview: Float32Array.from([-1, 0]), passages: [] },
    ];
    const results = rankIncidentVectors(incidents, [2, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0].incident_id).toBe(2);
    expect(results[0].score).toBeCloseTo(0.74);
    expect(rankIncidentVectors(incidents, [1, 0], Infinity).map((hit) => hit.incident_id)).toEqual([
      2, 1,
    ]);
  });

  it('uses the overview without passages and handles negative similarities and invalid queries', () => {
    const incidents = [
      { incidentId: 7, overview: Float32Array.from([1, 0]), passages: [] },
      {
        incidentId: 8,
        overview: Float32Array.from([1, 0]),
        passages: [Float32Array.from([-1, 0])],
      },
      { incidentId: 9, overview: Float32Array.from([1, 0, 0]), passages: [] },
    ];
    expect(rankIncidentVectors(incidents, [1, 0], 10)).toEqual([
      { incident_id: 7, score: 1 },
      { incident_id: 8, score: 0.30000000000000004 },
    ]);
    for (const query of [[], [0, 0], [NaN, 1], [Infinity, 1], [Number.MAX_VALUE, 1]]) {
      expect(rankIncidentVectors(incidents, query, 10)).toEqual([]);
    }
    expect(rankIncidentVectors(incidents, [1, 0], 0)).toEqual([]);
  });
});

describe('compatible corpus loading and cache isolation', () => {
  const index: EmbeddingIndexConfig = {
    ...profile,
    maxInputChars: 8000,
    overlapChars: 200,
    indexSignature: 'test-signature',
  };
  const row = (id: number, overrides: Record<string, unknown> = {}) => ({
    incident_id: id,
    embedding_schema_version: 2,
    embedding_profile: index.profileId,
    model: index.model,
    base_url: index.baseUrl,
    index_signature: index.indexSignature,
    dims: 2,
    overview: { vector: binary([3, 4]) },
    passages: [{ vector: binary([1, 0]) }],
    ...overrides,
  });
  // A local cursor double exercises the actual loader filter without a MongoDB connection.
  const source = (documents: Record<string, any>[]) => {
    const close = jest.fn().mockResolvedValue(undefined);
    const find = jest.fn((filter: Record<string, unknown>) => ({
      sort: () => ({
        async *[Symbol.asyncIterator]() {
          yield* documents.filter((doc) =>
            Object.entries(filter).every(([key, value]) => doc[key] === value)
          );
        },
        close,
      }),
    }));
    const db = jest.fn(() => ({ collection: () => ({ find }) }));
    return { client: { db } as unknown as MongoClient, find, db, close };
  };

  afterEach(() => jest.restoreAllMocks());

  it('loads only compatible schema-v2 vectors and skips malformed rows and passages', async () => {
    const corpus = source([
      row(1, { passages: [{ vector: binary([1, 0]) }, { vector: binary([0, 0]) }] }),
      row(2, { embedding_schema_version: 1 }),
      row(3, { model: 'other' }),
      row(4, { base_url: 'https://other.test' }),
      row(5, { embedding_profile: 'other' }),
      row(6, { index_signature: 'other' }),
      row(7, { dims: 3 }),
      row(8, { overview: { vector: binary([0, 0]) } }),
      row(0),
    ]);
    const results = await createIncidentVectorLoader().load(corpus.client, index, 2);
    expect(results.map((result) => result.incidentId)).toEqual([1]);
    expect(results[0].passages).toHaveLength(1);
    expect(corpus.find.mock.calls[0][0]).toMatchObject({
      embedding_schema_version: 2,
      base_url: index.baseUrl,
      index_signature: index.indexSignature,
    });
    expect(corpus.close).toHaveBeenCalledTimes(1);
  });

  it('reuses compatible vectors until the ten-minute TTL expires and supports clearing', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const corpus = source([row(1)]);
    const loader = createIncidentVectorLoader();
    const first = await loader.load(corpus.client, index, 2);
    now.mockReturnValue(599999);
    expect(await loader.load(corpus.client, index, 2)).toBe(first);
    expect(corpus.find).toHaveBeenCalledTimes(1);
    now.mockReturnValue(600000);
    expect(await loader.load(corpus.client, index, 2)).not.toBe(first);
    loader.clear();
    await loader.load(corpus.client, index, 2);
    expect(corpus.find).toHaveBeenCalledTimes(3);
  });

  it('isolates clients, databases, model, endpoint, profile, signature, and dimensions', async () => {
    const corpus = source([row(1)]);
    const loader = createIncidentVectorLoader();
    await loader.load(corpus.client, index, 2);
    const other = source([row(2)]);
    expect((await loader.load(other.client, index, 2))[0].incidentId).toBe(2);
    await loader.load(corpus.client, index, 2, 'staging');
    expect(corpus.db).toHaveBeenLastCalledWith('staging');
    for (const change of [
      { model: 'other' },
      { baseUrl: 'https://other.test' },
      { profileId: 'other' },
      { indexSignature: 'other' },
    ]) {
      expect(await loader.load(corpus.client, { ...index, ...change }, 2)).toEqual([]);
    }
    expect(await loader.load(corpus.client, index, 3)).toEqual([]);
    expect(corpus.find).toHaveBeenCalledTimes(7);
  });

  it('does not cache an empty corpus and validates dimensions before accessing the database', async () => {
    const documents: Record<string, any>[] = [];
    const corpus = source(documents);
    const loader = createIncidentVectorLoader();
    expect(await loader.load(corpus.client, index, 2)).toEqual([]);
    documents.push(row(1));
    expect(await loader.load(corpus.client, index, 2)).toHaveLength(1);
    await expect(loader.load(corpus.client, index, 0)).rejects.toThrow('positive integer');
    expect(corpus.find).toHaveBeenCalledTimes(2);
  });
});
