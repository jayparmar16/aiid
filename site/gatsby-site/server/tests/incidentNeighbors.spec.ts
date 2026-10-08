import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { Binary, Collection, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getConfiguredEmbeddingIndex } from '../../src/utils/embeddings/config';
import { refreshIncidentNeighbors } from '../../src/utils/embeddings/neighbors';

const execute = promisify(execFile);
const binary = (vector: number[]) => Binary.fromFloat32Array(Float32Array.from(vector));

jest.mock('../../i18n', () => ({
  switchLocalizedPath: ({ newLang, path }: any) => `/${newLang}${path}`,
}));
const createCitationPages = require('../../page-creators/createCitationPages');

describe('derived incident neighbor refresh', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  const originalEnv = process.env;
  const originalFetch = global.fetch;
  const originalList = [{ incident_id: 99, similarity: 0.99 }];
  const sourceFields = {
    title: 'Title',
    description: 'Description',
    reports: [1],
    embedding: { vector: [99, 99], from_reports: [1] },
    tsne: { x: 0.4, y: -0.2 },
    editor_similar_incidents: [7],
    editor_dissimilar_incidents: [3],
    flagged_dissimilar_incidents: [4],
    date_modified: 'original',
  };
  const row = (id: number, overview: number[], passages: number[][] = []) => {
    const index = getConfiguredEmbeddingIndex();
    return {
      incident_id: id,
      embedding_schema_version: 2,
      embedding_profile: index.profileId,
      model: index.model,
      base_url: index.baseUrl,
      index_signature: index.indexSignature,
      dims: overview.length,
      overview: { vector: binary(overview) },
      passages: passages.map((vector) => ({ vector: binary(vector) })),
    };
  };
  const collection = () => client.db('aiidprod').collection('incidents');
  const embeddings = () => client.db('aiidprod').collection('incident_embeddings');
  const neighbors = async (id = 1) =>
    (await collection().findOne({ incident_id: id }))!.nlp_similar_incidents;

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
      EMBEDDING_MODEL: 'vendor/neighbor-test',
      EMBEDDING_API_BASE_URL: 'https://embedding.test/v1',
      EMBEDDING_MAX_INPUT_CHARS: '100',
      EMBEDDING_CHUNK_OVERLAP_CHARS: '10',
    };
    delete process.env.EMBEDDING_API_KEY;
    global.fetch = jest.fn(() => {
      throw new Error('Must not call a provider');
    });
    await collection().deleteMany({});
    await embeddings().deleteMany({});
    await collection().insertMany(
      Array.from({ length: 12 }, (_, index) => ({
        incident_id: index + 1,
        ...sourceFields,
        nlp_similar_incidents: originalList,
      }))
    );
    await client.db('history').collection('incidents').deleteMany({});
    await client
      .db('history')
      .collection('incidents')
      .insertOne({ incident_id: 1, nlp_similar_incidents: originalList });
    await embeddings().insertMany([
      row(1, [1, 0], [[1, 0]]),
      row(2, [0.6, 0.8], [[1, 0]]), // .74 for source 1
      row(3, [0, 1], [[1, 0]]), // .35, despite editor exclusion (retained separately)
      row(4, [0.8, 0.6]), // .8, flagged (flag retained separately)
      row(5, [-1, 0]), // No matches for source 1
      { ...row(6, [1, 0]), embedding_schema_version: 1 },
      { ...row(7, [1, 0]), model: 'other-model' },
      { ...row(8, [1, 0]), base_url: 'https://other.test' },
      { ...row(9, [1, 0]), embedding_profile: 'other-profile' },
      { ...row(10, [1, 0]), index_signature: 'other-signature' },
      row(11, [0, 0]),
      { ...row(12, [1, 0]), dims: 3 },
      row(99, [1, 0, 0]), // Deleted incident, must not cause mixed dimensions.
    ]);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it('refreshes top-three weighted neighbors, excluding self/deleted/incompatible incidents before limiting', async () => {
    const summary = await refreshIncidentNeighbors(client);
    expect(summary).toEqual({
      targets: 12,
      corpus: 5,
      skipped: 7,
      unchanged: 0,
      changed: 5,
      written: 5,
      dryRun: false,
    });
    const list = await neighbors();
    expect(list.map((neighbor: any) => neighbor.incident_id)).toEqual([4, 2, 3]);
    expect(list[0].similarity).toBeCloseTo(0.8);
    expect(list[1].similarity).toBeCloseTo(0.74);
    expect(list[2].similarity).toBeCloseTo(0.35);
    expect(await neighbors(5)).toEqual([]);
    expect(await neighbors(6)).toEqual(originalList);
    const incident = await collection().findOne({ incident_id: 1 });
    expect(incident).toMatchObject(sourceFields);
    expect(
      (await client.db('history').collection('incidents').findOne({ incident_id: 1 }))!
        .nlp_similar_incidents
    ).toEqual(originalList);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is idempotent and recomputes incoming neighbors when an unrelated incident vector changes', async () => {
    await refreshIncidentNeighbors(client);
    expect(await refreshIncidentNeighbors(client)).toMatchObject({
      unchanged: 5,
      changed: 0,
      written: 0,
    });
    await embeddings().updateOne(
      { incident_id: 2 },
      { $set: { 'overview.vector': binary([1, 0]) } }
    );
    expect((await refreshIncidentNeighbors(client)).written).toBeGreaterThan(0);
    expect((await neighbors())[0].incident_id).toBe(2);
  });

  it('uses the entire candidate corpus even when only one target is selected', async () => {
    expect(await refreshIncidentNeighbors(client, { limit: 1 })).toMatchObject({
      targets: 1,
      changed: 1,
      written: 1,
    });
    expect((await neighbors()).map((neighbor: any) => neighbor.incident_id)).toEqual([4, 2, 3]);
    expect(await neighbors(2)).toEqual(originalList);
    expect(await refreshIncidentNeighbors(client, { incidentIds: [2], num: 1 })).toMatchObject({
      targets: 1,
      written: 1,
    });
    expect(await neighbors(2)).toHaveLength(1);
    expect((await neighbors(2))[0].incident_id).not.toBe(2);
  });

  it('computes a dry run without writes and permits unchanged reruns', async () => {
    const writes = jest.spyOn(Collection.prototype, 'bulkWrite');
    expect(await refreshIncidentNeighbors(client, { dryRun: true })).toMatchObject({
      changed: 5,
      written: 0,
      dryRun: true,
    });
    expect(writes).not.toHaveBeenCalled();
    expect(await neighbors()).toEqual(originalList);
  });

  it('clears a stale list for a solitary valid incident and permits an empty database', async () => {
    await collection().deleteMany({ incident_id: { $ne: 1 } });
    expect(await refreshIncidentNeighbors(client)).toMatchObject({
      targets: 1,
      corpus: 1,
      written: 1,
    });
    expect(await neighbors()).toEqual([]);
    await collection().deleteMany({});
    expect(await refreshIncidentNeighbors(client)).toMatchObject({
      targets: 0,
      corpus: 0,
      written: 0,
    });
  });

  it('breaks equal-score ties by incident ID', async () => {
    await embeddings().replaceOne({ incident_id: 3 }, row(3, [1, 0]));
    await embeddings().replaceOne({ incident_id: 4 }, row(4, [1, 0]));
    await refreshIncidentNeighbors(client, { incidentIds: [1] });
    expect((await neighbors()).map((neighbor: any) => neighbor.incident_id)).toEqual([3, 4, 2]);
  });

  it('retains all lists and fails when configuration has no compatible corpus', async () => {
    process.env.EMBEDDING_MODEL = 'unbackfilled-model';
    await expect(refreshIncidentNeighbors(client)).rejects.toThrow(
      'No compatible incident embeddings'
    );
    expect(await neighbors()).toEqual(originalList);
  });

  it('rejects mixed valid dimensions before any writes', async () => {
    await embeddings().replaceOne({ incident_id: 6 }, row(6, [1, 0, 0]));
    await expect(refreshIncidentNeighbors(client)).rejects.toThrow('mixed dimensions');
    expect(await neighbors()).toEqual(originalList);
  });

  it.each([{ limit: 0 }, { limit: 1.5 }, { num: 0 }, { num: -1 }, { incidentIds: [-1] }])(
    'rejects invalid options %j',
    async (options) => {
      await expect(refreshIncidentNeighbors(client, options)).rejects.toThrow('positive integer');
      expect(await neighbors()).toEqual(originalList);
    }
  );

  it('supports cancellation before reading or writing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(refreshIncidentNeighbors(client, { signal: controller.signal })).rejects.toThrow();
    expect(await neighbors()).toEqual(originalList);
  });

  it('awaits bounded write batches and propagates write failures for safe reruns', async () => {
    const writes = jest
      .spyOn(Collection.prototype, 'bulkWrite')
      .mockRejectedValueOnce(new Error('write failed'));
    await expect(refreshIncidentNeighbors(client)).rejects.toThrow('write failed');
    expect(await neighbors()).toEqual(originalList);
    writes.mockRestore();
    await collection().deleteMany({});
    await embeddings().deleteMany({});
    await collection().insertMany(Array.from({ length: 105 }, (_, i) => ({ incident_id: i + 1 })));
    await embeddings().insertMany(Array.from({ length: 105 }, (_, i) => row(i + 1, [1, 0])));
    const batches = jest.spyOn(Collection.prototype, 'bulkWrite');
    expect(await refreshIncidentNeighbors(client)).toMatchObject({
      targets: 105,
      changed: 105,
      written: 105,
    });
    expect(batches.mock.calls.map(([operations]) => operations.length)).toEqual([100, 5]);
    expect(await neighbors()).toHaveLength(3);
  });

  it('passes generated rankings and translated titles through the existing static citation-page contract', async () => {
    await refreshIncidentNeighbors(client);
    const nodes = (
      await collection()
        .find({ incident_id: { $lte: 5 } })
        .sort({ incident_id: 1 })
        .toArray()
    ).map((incident) => ({ ...incident, reports: [] }));
    const graphql = jest.fn().mockResolvedValue({
      data: {
        allMongodbAiidprodIncidents: { nodes },
        allMongodbAiidprodIncidentLinks: { nodes: [] },
        allMongodbTranslationsIncidents: {
          nodes: [{ incident_id: 4, language: 'es', title: 'Translated fourth incident' }],
        },
      },
    });
    const createPage = jest.fn();
    await createCitationPages(graphql, createPage, { languages: [{ code: 'en' }, { code: 'es' }] });
    const contexts = createPage.mock.calls
      .map(([page]) => page.context)
      .filter((context) => context.incident_id === 1);
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context.nlp_similar_incidents.map((incident: any) => incident.incident_id)).toEqual([
        4, 2, 3,
      ]);
      expect(context.nlp_similar_incidents[0]).toMatchObject({
        similarity: expect.any(Number),
        translations: [{ language: 'es', title: 'Translated fourth incident' }],
      });
    }
  });

  const run = (args: string[]) =>
    execute(
      process.execPath,
      [
        '--import',
        path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs'),
        path.resolve(__dirname, '../../src/scripts/refresh-incident-neighbors.ts'),
        ...args,
      ],
      {
        cwd: path.resolve(__dirname, '../..'),
        timeout: 15000,
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH,
          MONGODB_CONNECTION_STRING: mongo.getUri(),
          EMBEDDING_MODEL: 'vendor/neighbor-test',
          EMBEDDING_API_BASE_URL: 'https://embedding.test/v1',
          EMBEDDING_MAX_INPUT_CHARS: '100',
          EMBEDDING_CHUNK_OVERLAP_CHARS: '10',
        },
      }
    );

  it('runs the real CLI without provider credentials, honors dry-run/limit, and exits cleanly', async () => {
    const preview = await run(['--limit', '1', '--dry-run']);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      targets: 1,
      changed: 1,
      written: 0,
      dryRun: true,
    });
    expect(await neighbors()).toEqual(originalList);
    const first = await run(['--incident-id', '1', '--num', '2']);
    expect(JSON.parse(first.stdout)).toMatchObject({ targets: 1, written: 1 });
    expect((await neighbors()).map((neighbor: any) => neighbor.incident_id)).toEqual([4, 2]);
    const second = await run(['--incident-id', '1', '--num', '2']);
    expect(JSON.parse(second.stdout)).toMatchObject({ changed: 0, written: 0, unchanged: 1 });
  }, 20000);

  it('rejects invalid CLI arguments with a failure exit code and no writes', async () => {
    await expect(run(['--limit', '0'])).rejects.toMatchObject({ code: 1 });
    await expect(run(['--unknown'])).rejects.toMatchObject({ code: 1 });
    expect(await neighbors()).toEqual(originalList);
  }, 20000);
});
