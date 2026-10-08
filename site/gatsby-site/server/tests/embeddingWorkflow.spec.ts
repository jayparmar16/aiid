import { readFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const { parse } = require('yaml');
const workflow = parse(
  readFileSync(path.resolve(__dirname, '../../../../.github/workflows/embed-incidents.yml'), 'utf8')
);
const steps = workflow.jobs['embed-incidents'].steps;
const embedding = steps.find((step: any) => step.name === 'Embed incidents');
const neighbors = steps.find((step: any) => step.name === 'Refresh stored incident neighbors');

describe('local embedding workflow contract', () => {
  it('keeps the daily schedule and serialized environment-specific job', () => {
    expect(workflow.on.schedule).toEqual([{ cron: '0 8 * * *' }]);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.concurrency.group).toContain("inputs.environment || 'production'");
  });

  it('refreshes only after successful ingestion, runs nightly, and permits a manual opt-out', () => {
    expect(steps.indexOf(neighbors)).toBeGreaterThan(steps.indexOf(embedding));
    expect(neighbors.if).toContain('success()');
    expect(neighbors.if).toContain("github.event_name == 'schedule'");
    expect(neighbors.if).toContain('inputs.refresh_neighbors');
    expect(workflow.on.workflow_dispatch.inputs.refresh_neighbors).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });

  it('uses the ingestion database and index configuration without provider credentials', () => {
    for (const key of [
      'MONGODB_CONNECTION_STRING',
      'EMBEDDING_MODEL',
      'EMBEDDING_API_BASE_URL',
      'EMBEDDING_MAX_INPUT_CHARS',
      'EMBEDDING_CHUNK_OVERLAP_CHARS',
    ]) {
      expect(neighbors.env[key]).toBe(embedding.env[key]);
    }
    expect(neighbors.env).not.toHaveProperty('EMBEDDING_API_KEY');
    expect(neighbors.env.RUN_LIMIT).toBe(embedding.env.RUN_LIMIT);
    expect(neighbors['working-directory']).toBe('site/gatsby-site');
  });

  it('has valid Bash syntax and forwards only a positive target limit', () => {
    execFileSync('bash', ['-n', '-c', neighbors.run]);
    // Stub npm in-memory: validate the actual workflow shell without running a service or job.
    const run = (limit: string) =>
      execFileSync('bash', ['-c', `npm() { printf '%s\\n' "$@"; }\n${neighbors.run}`], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH, RUN_LIMIT: limit },
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
    expect(run('5')).toEqual(['run', 'refresh-incident-neighbors:ci', '--', '--limit', '5']);
    expect(run('0')).toEqual(['run', 'refresh-incident-neighbors:ci', '--']);
    expect(run('')).toEqual(['run', 'refresh-incident-neighbors:ci', '--']);
  });
});
