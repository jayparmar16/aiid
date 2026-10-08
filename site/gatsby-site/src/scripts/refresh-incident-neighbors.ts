/** Refresh machine-generated neighbor lists from the complete compatible schema-v2 corpus. */
import { MongoClient } from 'mongodb';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { refreshIncidentNeighbors } from '../utils/embeddings/neighbors';

export const main = async (): Promise<number> => {
  const argv = yargs(hideBin(process.argv))
    .usage('Usage: npm run refresh-incident-neighbors -- [options]')
    .option('incident-id', {
      describe: 'Only refresh these incident IDs (repeatable)',
      type: 'number',
      array: true,
    })
    .option('limit', {
      describe: 'Refresh at most this many incidents; candidates remain the full corpus',
      type: 'number',
    })
    .option('num', { describe: 'Maximum neighbors per incident', type: 'number', default: 3 })
    .option('dry-run', {
      describe: 'Compute and report changes without writing',
      type: 'boolean',
      default: false,
    })
    .strict()
    .help()
    .alias('h', 'help')
    .parseSync();
  const connectionString = process.env.MONGODB_CONNECTION_STRING;
  if (!connectionString) throw new Error('MONGODB_CONNECTION_STRING is required.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const client = new MongoClient(connectionString, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const summary = await refreshIncidentNeighbors(client, {
      incidentIds: argv['incident-id'],
      limit: argv.limit,
      num: argv.num,
      dryRun: argv['dry-run'],
      signal: controller.signal,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.skipped > 0)
      console.warn(
        `${summary.skipped} incident(s) have no compatible overview; their lists were retained.`
      );
    return 0;
  } catch (error) {
    if (controller.signal.aborted) {
      console.warn('Neighbor refresh cancelled; rerun to finish remaining lists.');
      return 130;
    }
    throw error;
  } finally {
    await client.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
};

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
