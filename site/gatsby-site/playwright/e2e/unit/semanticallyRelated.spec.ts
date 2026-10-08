import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from '@babel/core';
import { buildIncidentOverview } from '../../../src/utils/embeddings/incidentText';

// Exercise the real component in React, with only its service/presentation boundaries mocked.
// No Gatsby server, live provider, database, or remote deployment is involved.
const source = readFileSync(path.resolve('src/components/SemanticallyRelatedIncidents.js'), 'utf8');
const component = transformSync(source, {
  babelrc: false,
  configFile: false,
  plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs'],
})!.code!;
const article = 'Report details '.repeat(30);

async function mount(page: Page, props: Record<string, unknown>) {
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
  );
  await page.goto('http://suggestions.test/');
  await page.clock.install();
  for (const file of [
    'react/umd/react.development.js',
    'react-dom/umd/react-dom.development.js',
    'lodash/lodash.min.js',
  ]) {
    await page.addScriptTag({ content: readFileSync(path.resolve('node_modules', file), 'utf8') });
  }
  await page.evaluate(
    ({ code, overview, initial }) => {
      const w = window as any;
      const React = w.React;
      w.fields = [];
      w.requests = [];
      w.reply = [
        { incident_id: 2, similarity: 0.7 },
        { incident_id: 1, similarity: 0.9 },
      ];
      w.setFieldValue = (name: string, value: unknown) => w.fields.push({ name, value });
      w.client = {
        query: async ({ variables }: any) => ({
          data: {
            incidents: [...variables.filter.incident_id.IN].reverse().map((id: number) => ({
              incident_id: id,
              title: `Incident ${id}`,
            })),
          },
        }),
      };
      w.fetch = async (_url: string, options: any) => {
        w.requests.push({ ...JSON.parse(options.body), signal: options.signal });
        return { ok: true, json: async () => ({ embedding: null, incidents: w.reply }) };
      };
      const t = (text: string, options: any) => text.replace('{{minLength}}', options?.minLength);
      const dependencies: Record<string, unknown> = {
        react: React,
        '@apollo/client': { gql: (query: string) => query, useApolloClient: () => w.client },
        'lodash/debounce': w._.debounce,
        './RelatedIncidentsArea': ({ incidents, loading, error }: any) =>
          React.createElement(
            'section',
            null,
            React.createElement('div', { 'data-testid': 'status' }, loading ? 'loading' : 'idle'),
            React.createElement('div', { 'data-testid': 'error' }, error),
            incidents.map((row: any) =>
              React.createElement('div', { key: row.incident_id, 'data-testid': 'hit' }, row.title)
            )
          ),
        '../utils/typography': { stripMarkdown: async (text: string) => text },
        '../utils/embeddings/incidentText': {
          buildIncidentOverview: new Function(`return (${overview})`)(),
        },
        'react-i18next': { useTranslation: () => ({ t }) },
      };
      const module = { exports: {} as any };
      new Function('require', 'module', 'exports', code)(
        (name: string) => {
          if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
          return dependencies[name];
        },
        module,
        module.exports
      );
      const root = w.ReactDOM.createRoot(document.getElementById('root'));
      w.renderSuggestions = (next: any) =>
        root.render(
          React.createElement(module.exports.default, { ...next, setFieldValue: w.setFieldValue })
        );
      w.renderSuggestions(initial);
    },
    { code: component, overview: buildIncidentOverview.toString(), initial: props }
  );
  await expect(page.getByTestId('status')).toHaveText('loading');
}

async function settle(page: Page) {
  await page.clock.runFor(2100);
  await expect(page.getByTestId('status')).toHaveText('idle');
}

test('fetches fresh ranked suggestions, ignoring saved legacy values and never assigning embedding', async ({
  page,
}) => {
  await mount(page, {
    incident: { text: article, nlp_similar_incidents: [{ incident_id: 99 }], embedding: [1] },
  });
  await settle(page);
  await expect(page.getByTestId('hit')).toHaveText(['Incident 1', 'Incident 2']);
  const fields = await page.evaluate(() => (window as any).fields);
  expect(fields.every((field: any) => field.name === 'nlp_similar_incidents')).toBe(true);
  expect(fields[fields.length - 1].value.map((row: any) => row.incident_id)).toEqual([1, 2]);
});

test('requires 256 non-whitespace report characters and clears suggestions on empty text', async ({
  page,
}) => {
  await mount(page, { incident: { text: 'a \n\t'.repeat(200) } });
  await settle(page);
  await expect(page.getByTestId('error')).toContainText('256 non-space characters');
  expect(await page.evaluate(() => (window as any).requests.length)).toBe(0);
  await page.evaluate(() => (window as any).renderSuggestions({ incident: { text: '' } }));
  await expect(page.getByTestId('status')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fields.slice(-1)[0].value)).toEqual([]);
});

test('uses short incident title/description, excludes self, and updates after editing', async ({
  page,
}) => {
  await mount(page, {
    incident: { title: 'Title', description: 'Description' },
    useIncidentOverview: true,
    excludeIncidentId: 10,
  });
  await settle(page);
  expect(
    await page.evaluate(() => {
      const { text, excludeIncidentId } = (window as any).requests[0];
      return { text, excludeIncidentId };
    })
  ).toEqual({ text: 'Title: Title\n\nDescription: Description', excludeIncidentId: 10 });
  await page.evaluate(() =>
    (window as any).renderSuggestions({
      incident: { title: 'Changed', description: 'Description' },
      useIncidentOverview: true,
      excludeIncidentId: 10,
    })
  );
  await expect(page.getByTestId('status')).toHaveText('loading');
  await settle(page);
  expect(await page.evaluate(() => (window as any).requests[1].text)).toContain('Changed');
});

test('cancels an obsolete debounce before making a request', async ({ page }) => {
  await mount(page, { incident: { text: article } });
  await page.evaluate(
    (text) => (window as any).renderSuggestions({ incident: { text } }),
    `New ${article}`
  );
  // Wait for the changed input's effect without advancing the debounce clock.
  await expect.poll(() => page.evaluate(() => (window as any).fields.length)).toBe(2);
  await settle(page);
  expect(await page.evaluate(() => (window as any).requests.map((row: any) => row.text))).toEqual([
    `New ${article}`,
  ]);
});

test('aborts obsolete work and prevents a late database result from overwriting newer suggestions', async ({
  page,
}) => {
  await mount(page, { incident: { text: article } });
  await page.evaluate(() => {
    const w = window as any;
    const query = w.client.query;
    w.client.query = async (options: any) => {
      if (!w.release)
        return new Promise((resolve) => {
          w.release = () =>
            resolve({ data: { incidents: [{ incident_id: 1, title: 'Stale incident' }] } });
        });
      return query(options);
    };
  });
  await page.clock.runFor(2100);
  await expect.poll(() => page.evaluate(() => Boolean((window as any).release))).toBe(true);
  await page.evaluate((text) => {
    const w = window as any;
    w.reply = [{ incident_id: 3, similarity: 0.8 }];
    w.renderSuggestions({ incident: { text } });
  }, `New ${article}`);
  await expect
    .poll(() => page.evaluate(() => (window as any).requests[0].signal.aborted))
    .toBe(true);
  await settle(page);
  await expect(page.getByTestId('hit')).toHaveText(['Incident 3']);
  await page.evaluate(async () => {
    (window as any).release();
    await Promise.resolve();
  });
  await expect(page.getByTestId('hit')).toHaveText(['Incident 3']);
});

test('handles unavailable providers, empty matches, and database errors without staying in loading state', async ({
  page,
}) => {
  await mount(page, { incident: { text: article } });
  await page.evaluate(() => {
    (window as any).fetch = async () => ({ ok: false, status: 503 });
  });
  await settle(page);
  await expect(page.getByTestId('error')).toHaveText('Could not compute semantic similarity');
  await page.evaluate((text) => {
    const w = window as any;
    w.fetch = async () => ({ ok: true, json: async () => ({ incidents: [] }) });
    w.renderSuggestions({ incident: { text } });
  }, `Empty ${article}`);
  await expect(page.getByTestId('status')).toHaveText('loading');
  await settle(page);
  await expect(page.getByTestId('hit')).toHaveCount(0);
  await expect(page.getByTestId('error')).toBeEmpty();
  await page.evaluate((text) => {
    const w = window as any;
    w.fetch = async () => ({
      ok: true,
      json: async () => ({ incidents: [{ incident_id: 1, similarity: 1 }] }),
    });
    w.client.query = async () => {
      throw new Error('unavailable');
    };
    w.renderSuggestions({ incident: { text } });
  }, `Error ${article}`);
  await expect(page.getByTestId('status')).toHaveText('loading');
  await settle(page);
  await expect(page.getByTestId('error')).toHaveText(
    'Could not retrieve related incidents from database'
  );
});
