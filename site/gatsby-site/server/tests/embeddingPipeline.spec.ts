/** Exercises the real CLI against an isolated MongoDB and a local embedding service. */
import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { Binary, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createIncidentVectorLoader } from '../../src/utils/embeddings/vectors';
import { getEmbeddingIndexConfig } from '../../src/utils/embeddings/config';

const execute = promisify(execFile);

describe('incident embedding CLI smoke and resume', () => {
  let mongo: MongoMemoryServer;
  let client: MongoClient;
  let server: Server;
  let directory: string;
  let baseUrl: string;
  let requests: string[][];
  const siteDirectory = path.resolve(__dirname, '../..');
  const model = 'vendor/smoke-model';

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'aiid-embedding-smoke-'));
    mongo = await MongoMemoryServer.create();
    client = await new MongoClient(mongo.getUri()).connect();
    requests = [];
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body).input as string[];
      requests.push(input);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // Returning results out of order also checks provider index handling.
      response.end(
        JSON.stringify({
          data: input
            .map((text, index) => ({
              index,
              embedding: [text.length, 2, 3],
            }))
            .reverse(),
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  }, 60000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    if (client) await client.close();
    if (mongo) await mongo.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const run = (args: string[], overrides: Record<string, string> = {}) =>
    execute(
      process.execPath,
      [
        '--import',
        path.join(siteDirectory, 'node_modules/tsx/dist/loader.mjs'),
        path.join(siteDirectory, 'src/scripts/embed-incidents.ts'),
        ...args,
      ],
      {
        cwd: directory,
        timeout: 30000,
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH,
          MONGODB_CONNECTION_STRING: mongo.getUri(),
          EMBEDDING_API_KEY: 'local-test-key',
          EMBEDDING_API_BASE_URL: baseUrl,
          EMBEDDING_MODEL: model,
          EMBEDDING_MAX_INPUT_CHARS: '500',
          EMBEDDING_CHUNK_OVERLAP_CHARS: '50',
          EMBEDDING_BATCH_SIZE: '2',
          EMBEDDING_CONCURRENCY: '1',
          EMBEDDING_MAX_ATTEMPTS: '1',
          ...overrides,
        },
      }
    );

  it('embeds five incidents in bounded batches and resumes only changed sources/configurations', async () => {
    const db = client.db('aiidprod');
    const legacy = { vector: [1, 0], from_reports: [1] };
    await db.collection('incidents').insertMany(
      Array.from({ length: 5 }, (_, index) => ({
        incident_id: index + 1,
        title: `Incident ${index + 1}`,
        description: `Description ${index + 1}`,
        reports: [index + 1],
        embedding: legacy,
      }))
    );
    const article = 'An article paragraph describing the incident and its effects. '.repeat(20);
    await db.collection('reports').insertMany(
      Array.from({ length: 5 }, (_, index) => ({
        report_number: index + 1,
        plain_text: article,
        text: 'The plain_text body should take precedence.',
        embedding: { vector: [1, 0], from_text_hash: 'historical' },
      }))
    );

    const first = await run(['--limit', '5']);
    expect(first.stdout).toContain('embedded    5/5');
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.every((batch) => batch.length <= 2)).toBe(true);
    const before = await db
      .collection('incident_embeddings')
      .find()
      .sort({ incident_id: 1 })
      .toArray();
    expect(before).toHaveLength(5);
    for (const document of before) {
      expect(document).toMatchObject({
        embedding_schema_version: 2,
        model,
        base_url: baseUrl,
        embedding_profile: 'openai-compatible-v1',
        dims: 3,
      });
      expect(document.generated_at).toBeInstanceOf(Date);
      expect(document.overview.vector).toBeInstanceOf(Binary);
      expect(document.overview.vector.toFloat32Array()[0]).toBe(document.overview.source_chars);
      expect(document.passages.length).toBeGreaterThan(1);
      for (const passage of document.passages) {
        expect(passage.end_char - passage.start_char).toBeLessThanOrEqual(500);
        expect(passage.source_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(passage.vector.toFloat32Array()[0]).toBe(
          `Incident title: Incident ${document.incident_id}\n\n`.length +
            passage.end_char -
            passage.start_char
        );
      }
    }
    const indexes = await db.collection('incident_embeddings').indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { incident_id: 1 }, unique: true })
    );

    const requestCount = requests.length;
    const resumed = await run(['--resume']);
    expect(resumed.stdout).toContain('skipped     5');
    expect(requests).toHaveLength(requestCount);
    const unchanged = await db
      .collection('incident_embeddings')
      .find()
      .sort({ incident_id: 1 })
      .toArray();
    expect(unchanged).toEqual(before);

    // Verify the shared reader agrees with the configuration written by the CLI.
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      EMBEDDING_MAX_INPUT_CHARS: '500',
      EMBEDDING_CHUNK_OVERLAP_CHARS: '50',
    };
    try {
      const index = getEmbeddingIndexConfig({ model, baseUrl, profileId: 'openai-compatible-v1' });
      expect(
        (await createIncidentVectorLoader().load(client, index, 3)).map((row) => row.incidentId)
      ).toEqual([1, 2, 3, 4, 5]);
    } finally {
      process.env = originalEnv;
    }

    await db
      .collection('reports')
      .updateOne({ report_number: 1 }, { $set: { plain_text: `${article}Changed article.` } });
    const edited = await run(['--resume']);
    expect(edited.stdout).toContain('embedded    1/5');
    expect(edited.stdout).toContain('skipped     4');
    const changed = await db.collection('incident_embeddings').findOne({ incident_id: 1 });
    expect(changed!.source_hash).not.toBe(before[0].source_hash);
    expect(changed!.generated_at.getTime()).toBeGreaterThan(before[0].generated_at.getTime());

    const reconfigured = await run(['--resume', '--incident-id', '1'], {
      EMBEDDING_MAX_INPUT_CHARS: '400',
    });
    expect(reconfigured.stdout).toContain('embedded    1/1');
    expect(
      (await db.collection('incident_embeddings').findOne({ incident_id: 1 }))!.index_signature
    ).not.toBe(changed!.index_signature);
    expect(await db.collection('incident_embeddings').countDocuments()).toBe(5);
    expect((await db.collection('incidents').findOne({ incident_id: 1 }))!.embedding).toEqual(
      legacy
    );
    expect(
      (await db.collection('reports').findOne({ report_number: 1 }))!.embedding.from_text_hash
    ).toBe('historical');
  }, 60000);
});
