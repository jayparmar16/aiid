import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { Binary, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getConfiguredEmbeddingIndex } from '../../src/utils/embeddings/config';
import {
  projectOverviewVectors,
  updateTsneInDatabase,
  updateTsneWithClient,
} from '../../src/utils/embeddings/spatial';

const execute = promisify(execFile);
const binary = (values: number[]) => Binary.fromFloat32Array(Float32Array.from(values));

describe('schema-v2 spatial projection', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  const legacy = { vector: [99, 99], from_reports: [1] };
  const oldPosition = { x: 0.9, y: 0.9 };
  const row = (id: number, vector = [3, 4, 0]) => {
    const index = getConfiguredEmbeddingIndex();
    return {
      incident_id: id,
      embedding_schema_version: 2,
      embedding_profile: index.profileId,
      model: index.model,
      base_url: index.baseUrl,
      index_signature: index.indexSignature,
      dims: vector.length,
      overview: { vector: binary(vector) },
      passages: [{ vector: binary([99, 99]) }], // Deliberately irrelevant to this projection.
    };
  };

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
      EMBEDDING_MODEL: 'vendor/spatial-test',
      EMBEDDING_API_BASE_URL: 'https://embedding.test/v1/',
      EMBEDDING_MAX_INPUT_CHARS: '100',
      EMBEDDING_CHUNK_OVERLAP_CHARS: '10',
      TSNE_NITER: '250',
    };
    delete process.env.EMBEDDING_API_KEY;
    global.fetch = jest.fn(() => {
      throw new Error('Spatial projection must not request embeddings');
    });
    const db = client.db('aiidprod');
    await db.collection('incidents').deleteMany({});
    await db.collection('incident_embeddings').deleteMany({});
    await db.collection('incidents').insertMany(
      Array.from({ length: 12 }, (_, index) => ({
        incident_id: index + 1,
        embedding: legacy,
        tsne: oldPosition,
      }))
    );
    await db.collection('incident_embeddings').insertMany([
      row(2, [0, 0, 2]),
      row(1),
      { ...row(4), embedding_schema_version: 1 },
      { ...row(5), model: 'other-model' },
      { ...row(6), base_url: 'https://other.test/v1' },
      { ...row(7), embedding_profile: 'other-profile' },
      { ...row(8), index_signature: 'other-signature' },
      row(9, [0, 0, 0]),
      row(10, [NaN, 1, 1]),
      { ...row(11), dims: 4 },
      { ...row(12), overview: { vector: [3, 4, 0] } },
      row(99, [1, 2, 3, 4]), // Deleted incident; must not cause mixed dimensions.
    ]);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('uses only compatible normalized overview vectors in incident-ID order and awaits writes', async () => {
    const project = jest.fn(() => [
      [0.25, -0.5],
      [-0.1, 0.2],
    ]);
    const positions = await updateTsneWithClient(
      client,
      getConfiguredEmbeddingIndex(),
      'aiidprod',
      project
    );
    const [vectors, iterations] = project.mock.calls[0] as unknown as [number[][], number];
    expect(iterations).toBe(250);
    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBeCloseTo(0.6);
    expect(vectors[0][1]).toBeCloseTo(0.8);
    expect(vectors[1]).toEqual([0, 0, 1]);
    expect(positions).toEqual([
      { incident_id: 1, tsne: { x: 0.25, y: -0.5 } },
      { incident_id: 2, tsne: { x: -0.1, y: 0.2 } },
    ]);
    const stored = await client
      .db('aiidprod')
      .collection('incidents')
      .find()
      .sort({ incident_id: 1 })
      .toArray();
    expect(stored[0].tsne).toEqual(positions[0].tsne);
    expect(stored[1].tsne).toEqual(positions[1].tsne);
    expect(stored[2].tsne).toEqual(oldPosition);
    expect(
      stored.every((incident) => JSON.stringify(incident.embedding) === JSON.stringify(legacy))
    ).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects mixed valid dimensions before any coordinate write', async () => {
    await client
      .db('aiidprod')
      .collection('incident_embeddings')
      .insertOne(row(3, [1, 2, 3, 4]));
    const project = jest.fn();
    await expect(
      updateTsneWithClient(client, getConfiguredEmbeddingIndex(), 'aiidprod', project)
    ).rejects.toThrow('mixed dimensions');
    expect(project).not.toHaveBeenCalled();
    expect(
      (await client.db('aiidprod').collection('incidents').findOne({ incident_id: 1 }))!.tsne
    ).toEqual(oldPosition);
  });

  it('returns no positions without a compatible corpus and never falls back to legacy vectors', async () => {
    process.env.EMBEDDING_MODEL = 'unbackfilled-model';
    const project = jest.fn();
    expect(
      await updateTsneWithClient(client, getConfiguredEmbeddingIndex(), 'aiidprod', project)
    ).toEqual([]);
    expect(project).not.toHaveBeenCalled();
  });

  it('handles zero, one, and two incidents without invoking unstable tiny t-SNE projections', async () => {
    expect(projectOverviewVectors([], 250)).toEqual([]);
    expect(projectOverviewVectors([[1, 0]], 250)).toEqual([[0, 0]]);
    expect(
      projectOverviewVectors(
        [
          [1, 0],
          [0, 1],
        ],
        250
      )
    ).toEqual([
      [-1, 0],
      [1, 0],
    ]);
    const positions = await updateTsneWithClient(client);
    expect(positions.map((incident) => incident.tsne)).toEqual([
      { x: -1, y: 0 },
      { x: 1, y: 0 },
    ]);
    await client.db('aiidprod').collection('incidents').deleteOne({ incident_id: 2 });
    expect(await updateTsneWithClient(client)).toEqual([{ incident_id: 1, tsne: { x: 0, y: 0 } }]);
  });

  it.each([
    [
      [NaN, 0],
      [0, 0],
    ],
    [
      [Infinity, 0],
      [0, 0],
    ],
    [
      [1.1, 0],
      [0, 0],
    ],
    [[0]],
  ])('rejects invalid projection output %j before writing', async (...points) => {
    await expect(
      updateTsneWithClient(client, getConfiguredEmbeddingIndex(), 'aiidprod', () => points)
    ).rejects.toThrow('invalid spatial coordinates');
    expect(
      (await client.db('aiidprod').collection('incidents').findOne({ incident_id: 1 }))!.tsne
    ).toEqual(oldPosition);
  });

  it.each(['0', '-1', 'invalid', '1.5'])('rejects invalid iteration count %s', async (value) => {
    process.env.TSNE_NITER = value;
    await expect(updateTsneWithClient(client)).rejects.toThrow('TSNE_NITER');
  });

  it('runs the real t-SNE library for a small backfill and produces finite scaled points', async () => {
    await client.db('aiidprod').collection('incident_embeddings').deleteMany({});
    await client
      .db('aiidprod')
      .collection('incident_embeddings')
      .insertMany([
        row(1, [1, 0, 0]),
        row(2, [0, 1, 0]),
        row(3, [0, 0, 1]),
        row(4, [1, 2, 3]),
        row(5, [3, 2, 1]),
      ]);
    const result = await updateTsneWithClient(client);
    expect(result.map((incident) => incident.incident_id)).toEqual([1, 2, 3, 4, 5]);
    expect(
      result.every(
        ({ tsne }) =>
          Number.isFinite(tsne.x) &&
          Number.isFinite(tsne.y) &&
          Math.abs(tsne.x) <= 1 &&
          Math.abs(tsne.y) <= 1
      )
    ).toBe(true);
  });

  it('closes the owned database client on success and failure', async () => {
    const close = jest.spyOn(MongoClient.prototype, 'close');
    await updateTsneInDatabase(mongo.getUri());
    expect(close).toHaveBeenCalledTimes(1);
    process.env.TSNE_NITER = '0';
    await expect(updateTsneInDatabase(mongo.getUri())).rejects.toThrow('TSNE_NITER');
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('loads through the real Gatsby CommonJS bridge, uses the source database, and exits cleanly', async () => {
    const { stdout } = await execute(
      process.execPath,
      [
        '-e',
        "require('./src/utils/updateTsne').updateTsneInDatabase().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; })",
      ],
      {
        cwd: path.resolve(__dirname, '../..'),
        timeout: 10000,
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH,
          GATSBY_SITE_URL: 'http://localhost',
          GATSBY_AVAILABLE_LANGUAGES: 'en',
          MONGODB_CONNECTION_STRING: mongo.getUri(),
          MONGODB_TRANSLATIONS_CONNECTION_STRING: 'mongodb://127.0.0.1:1',
          EMBEDDING_MODEL: 'vendor/spatial-test',
          EMBEDDING_API_BASE_URL: 'https://embedding.test/v1/',
          EMBEDDING_MAX_INPUT_CHARS: '100',
          EMBEDDING_CHUNK_OVERLAP_CHARS: '10',
        },
      }
    );
    expect(JSON.parse(stdout)).toEqual([
      { incident_id: 1, tsne: { x: -1, y: 0 } },
      { incident_id: 2, tsne: { x: 1, y: 0 } },
    ]);
  }, 15000);
});
