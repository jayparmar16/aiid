import { expect } from '@playwright/test';
import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { test } from '../../utils';

const url = '/apps/semantic-search/';

// The API returns an interpretation with every status. A query without constraints has nothing in it.
const unconstrained = { semanticText: '', constraints: [], warnings: [] };

const response = (
  status: string,
  results: unknown[] = [],
  interpretation: unknown = unconstrained
) => ({
  data: { semanticSearch: { status, results, interpretation } },
});

const results = Array.from({ length: 30 }, (_, index) => ({
  score: (30 - index) / 100,
  incident: {
    incident_id: index + 1,
    title: `Incident ${index + 1}`,
    date: '2026-01-01',
    description: index === 0 ? 'Description, "quoted"\nline' : `Description ${index + 1}`,
  },
}));

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  isArray: (tag) => ['sheet', 'Relationship', 'si', 'row', 'c'].includes(tag),
});

// Reads every sheet of an .xlsx file, in workbook order, as rows of cell text. The file is a zip of
// XML files, and its text cells hold indexes into one list of strings shared by all sheets.
const readWorkbook = (xlsx: Uint8Array) => {
  const files = unzipSync(xlsx);

  const read = (path: string) => xmlParser.parse(strFromU8(files[path]));

  const targets = new Map(
    read('xl/_rels/workbook.xml.rels').Relationships.Relationship.map((relationship: any) => [
      relationship['@_Id'],
      relationship['@_Target'],
    ])
  );

  // Text with leading or trailing spaces carries an attribute, which makes it parse as an object.
  const strings = read('xl/sharedStrings.xml').sst.si.map(({ t }: any) =>
    typeof t === 'object' ? t['#text'] : t
  );

  const sheets: Record<string, string[][]> = {};

  for (const sheet of read('xl/workbook.xml').workbook.sheets.sheet) {
    const { worksheet } = read(`xl/${targets.get(sheet['@_r:id'])}`);

    sheets[sheet['@_name']] = worksheet.sheetData.row.map((row: any) => {
      const cells: string[] = [];

      for (const cell of row.c ?? []) {
        // Cells are addressed like "B7", and these sheets never go past column Z.
        const column = cell['@_r'].charCodeAt(0) - 'A'.charCodeAt(0);

        cells[column] = cell['@_t'] === 's' ? strings[Number(cell.v)] : cell.v;
      }

      return Array.from(cells, (value) => value ?? '');
    });
  }

  return sheets;
};

test.describe('Semantic Search', () => {
  test('asks a logged-out visitor to log in instead of showing the search', async ({ page }) => {
    await page.goto(url);

    await expect(page.locator('[data-cy="api-login-required"]')).toBeVisible();
    await expect(page.locator('[data-cy="semantic-search-form"]')).toHaveCount(0);
    await expect(page.locator('[data-cy="semantic-search-examples"]')).toHaveCount(0);
  });

  test('runs each example immediately and supports results, sorting, pagination, and export errors', async ({
    page,
    login,
  }) => {
    // The search reads through the API, which requires a login (SEE: server/apiAccess.ts).
    await login({ customData: { roles: ['subscriber'] } });

    const queries: string[] = [];
    let releaseFirstRequest: (() => void) | undefined;

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      queries.push(request.variables.query);

      if (queries.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRequest = resolve;
        });
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', queries.length === 1 ? results : [])),
      });
    });

    await page.goto(url);

    const examples = page.locator('[data-cy="semantic-search-examples"] button');

    await expect(examples).toHaveCount(3);
    await page.locator('[data-cy="semantic-search-example-1"]').click();
    await expect.poll(() => Boolean(releaseFirstRequest)).toBe(true);
    await expect(page.locator('[data-cy="semantic-search-input"]')).toHaveValue(
      'deepfake related incidents'
    );
    await expect(examples.first()).toBeDisabled();
    await expect(page.getByRole('status')).toBeVisible();

    releaseFirstRequest?.();
    await expect(page.locator('[data-cy="semantic-search-count"]')).toHaveText(
      '30 matching incidents'
    );
    await expect(page.locator('[data-cy="row"]')).toHaveCount(25);
    await expect(page.locator('[data-cy="row"]').first()).toContainText('Incident 1');
    await expect(page.locator('[data-cy="total-pages"]')).toHaveText('2');

    await page.locator('[data-cy="last-page"]').click();
    await expect(page.locator('[data-cy="row"]')).toHaveCount(5);
    await expect(page.locator('[data-cy="row"]').first()).toContainText('Incident 26');

    await page.locator('[data-cy="first-page"]').click();
    await page.locator('[data-cy="header-score"] button').click();
    await expect(page.locator('[data-cy="row"]').first()).toContainText('Incident 30');

    const csvDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-cy="semantic-search-export-csv"]').click();
    const csvDownload = await csvDownloadPromise;
    const csvPath = await csvDownload.path();
    const csv = await readFile(csvPath!, 'utf8');

    expect(csvDownload.suggestedFilename()).toMatch(
      /^semantic-search-deepfake-related-incidents-\d{4}-\d{2}-\d{2}\.csv$/
    );
    expect(csv).toContain('\uFEFF"Score","Incident ID","Date","Title","Description","URL"');
    expect(csv).toContain('"0.3","1","2026-01-01","Incident 1","Description, ""quoted""\nline"');
    expect(csv).toContain('"30","2026-01-01","Incident 30"');
    expect(csv.match(/\/cite\//g)).toHaveLength(30);

    await page.evaluate(() => {
      URL.createObjectURL = () => {
        throw new Error('download failed');
      };
    });
    await page.locator('[data-cy="semantic-search-export-csv"]').click();
    await expect(page.locator('[data-cy="semantic-search-export-error"]')).toBeVisible();
    await page.locator('[data-cy="semantic-search-export"]').click();
    await expect(page.locator('[data-cy="semantic-search-export-error"]')).toBeVisible();

    await page.locator('[data-cy="semantic-search-example-2"]').click();
    await expect(page.locator('[data-cy="semantic-search-empty"]')).toBeVisible();
    await page.locator('[data-cy="semantic-search-example-3"]').click();
    await expect(page.locator('[data-cy="semantic-search-empty"]')).toBeVisible();

    expect(queries).toEqual([
      'deepfake related incidents',
      'facial recognition leading to a wrongful arrest',
      'autonomous vehicle crashes involving pedestrians',
    ]);
  });

  test('shows empty, quota, and unavailable states for submitted searches', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      const statuses: Record<string, string> = {
        empty: 'OK',
        quota: 'QUOTA_EXHAUSTED',
        unavailable: 'UNAVAILABLE',
      };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response(statuses[request.variables.query])),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const submit = page.locator('[data-cy="semantic-search-submit"]');

    await input.fill('empty');
    await submit.click();
    await expect(page.locator('[data-cy="semantic-search-empty"]')).toBeVisible();

    await input.fill('quota');
    await submit.click();
    await expect(page.locator('[data-cy="semantic-search-limited"]')).toBeVisible();

    await input.fill('unavailable');
    await submit.click();
    await expect(page.locator('[data-cy="semantic-search-unavailable"]')).toBeVisible();
  });

  test('shows how a query with an exclusion was read, alongside any status', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const excludingTesla = {
      semanticText: 'self-driving car incidents',
      constraints: [
        {
          kind: 'EXCLUDE_ENTITY',
          source: 'QUERY_TEXT',
          matchedText: 'tesla',
          incidentCount: 50,
          entities: [
            { entity_id: 'tesla', name: 'Tesla', matchedBy: 'NAME' },
            { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot', matchedBy: 'FAMILY' },
          ],
        },
      ],
      warnings: [{ code: 'UNRECOGNISED_EXCLUSION', text: 'robocall operators' }],
    };

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      const replies: Record<string, unknown> = {
        constrained: response('OK', results.slice(0, 2), excludingTesla),
        'constrained but limited': response('QUOTA_EXHAUSTED', [], excludingTesla),
        plain: response('OK', results.slice(0, 2)),
      };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(replies[request.variables.query]),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const submit = page.locator('[data-cy="semantic-search-submit"]');
    const interpretation = page.locator('[data-cy="semantic-search-interpretation"]');
    const exclusion = page.locator('[data-cy="semantic-search-exclusion"]');

    await input.fill('constrained');
    await submit.click();

    await expect(page.locator('[data-cy="semantic-search-semantic-text"]')).toHaveText(
      'Searching: self-driving car incidents'
    );
    await expect(exclusion).toHaveCount(1);
    await expect(exclusion).toContainText('Excluding: Tesla');
    await expect(exclusion).toContainText('2 entities · 50 incidents');
    await expect(exclusion).toHaveAttribute('title', 'Tesla, Tesla Autopilot');
    await expect(page.locator('[data-cy="semantic-search-warning"]')).toContainText(
      'robocall operators'
    );
    await expect(page.locator('[data-cy="row"]')).toHaveCount(2);

    await input.fill('constrained but limited');
    await submit.click();

    await expect(page.locator('[data-cy="semantic-search-limited"]')).toBeVisible();
    await expect(exclusion).toContainText('Excluding: Tesla');

    await input.fill('plain');
    await submit.click();

    await expect(page.locator('[data-cy="row"]')).toHaveCount(2);
    await expect(interpretation).toHaveCount(0);
  });

  test('describes the search in a second sheet of the Excel export', async ({ page, login }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const query = 'self-driving car incidents excluding tesla';

    const interpretation = {
      semanticText: 'self-driving car incidents',
      constraints: [
        {
          kind: 'EXCLUDE_ENTITY',
          source: 'QUERY_TEXT',
          matchedText: 'tesla',
          incidentCount: 50,
          entities: [
            { entity_id: 'tesla', name: 'Tesla', matchedBy: 'NAME' },
            { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot', matchedBy: 'FAMILY' },
          ],
        },
        // The page has no label for this kind or source, so the export writes them as named.
        {
          kind: 'NEW_KIND',
          source: 'NEW_SOURCE',
          matchedText: null,
          incidentCount: 0,
          entities: [],
        },
      ],
      warnings: [{ code: 'UNRECOGNISED_EXCLUSION', text: 'robocall operators' }],
    };

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', results.slice(0, 2), interpretation)),
      });
    });

    await page.goto(url);

    await page.locator('[data-cy="semantic-search-input"]').fill(query);
    await page.locator('[data-cy="semantic-search-submit"]').click();
    await expect(page.locator('[data-cy="row"]')).toHaveCount(2);

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-cy="semantic-search-export"]').click();
    const download = await downloadPromise;
    const workbook = readWorkbook(await readFile((await download.path())!));

    expect(download.suggestedFilename()).toMatch(
      /^semantic-search-self-driving-car-incidents-excluding-tesla-\d{4}-\d{2}-\d{2}\.xlsx$/
    );
    expect(Object.keys(workbook)).toEqual(['Results', 'Search']);
    expect(workbook.Results.map((row) => row[3])).toEqual(['Title', 'Incident 1', 'Incident 2']);

    const [queryRow, semanticTextRow, searchedAtRow, ...rest] = workbook.Search;

    expect(queryRow).toEqual(['Query', query]);
    expect(semanticTextRow).toEqual(['Semantic text', 'self-driving car incidents']);
    expect(searchedAtRow[0]).toBe('Searched at');
    expect(searchedAtRow[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);

    const searchedAt = Date.parse(searchedAtRow[1].replace(' ', 'T').replace(' UTC', 'Z'));

    expect(Math.abs(Date.now() - searchedAt)).toBeLessThan(5 * 60 * 1000);
    expect(rest).toEqual([
      [],
      ['Constraint', 'Matched text', 'Source', 'Entities', 'Incidents'],
      ['Excluding', 'tesla', 'Query text', 'Tesla, Tesla Autopilot', '50'],
      ['NEW_KIND', '', 'NEW_SOURCE', '', '0'],
      [],
      ['Warning', 'Text'],
      ['UNRECOGNISED_EXCLUSION', 'robocall operators'],
    ]);
  });
});
