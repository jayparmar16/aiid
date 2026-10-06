import { expect } from '@playwright/test';
import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { test } from '../../utils';

const url = '/apps/semantic-search/';

// The API returns an interpretation with every status. A query without constraints has nothing in it.
const unconstrained = { semanticText: '', constraints: [], warnings: [] };

// Fills in the fields the page asks for that a mocked interpretation leaves out, since Apollo
// returns no data at all for a reply that is missing a requested field.
const withDefaults = (interpretation: any) => ({
  suggestions: [],
  ...interpretation,
  constraints: interpretation.constraints.map((constraint: any) => ({
    roles: null,
    dateFrom: null,
    dateTo: null,
    ...constraint,
  })),
});

const response = (
  status: string,
  results: unknown[] = [],
  interpretation: unknown = unconstrained,
  totalCount = results.length
) => ({
  data: {
    semanticSearch: { status, totalCount, results, interpretation: withDefaults(interpretation) },
  },
});

const results = Array.from({ length: 30 }, (_, index) => ({
  score: (30 - index) / 100,
  incident: {
    incident_id: index + 1,
    title: `Incident ${index + 1}`,
    date: '2026-01-01',
    description: index === 0 ? 'Description, "quoted"\nline' : `Description ${index + 1}`,
  },
  // Only the first incident has a picture.
  image: index === 0 ? { cloudinary_id: 'reports/example.jpg', image_url: null } : null,
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
    const sentFilters: unknown[] = [];
    let releaseFirstRequest: (() => void) | undefined;

    // The second example's exclusion becomes a chip, which the third example must not inherit.
    const excludingTesla = {
      semanticText: 'self-driving crashes',
      constraints: [
        {
          kind: 'EXCLUDE_ENTITY',
          source: 'QUERY_TEXT',
          matchedText: 'tesla',
          incidentCount: 50,
          entities: [{ entity_id: 'tesla', name: 'Tesla', matchedBy: 'NAME' }],
        },
      ],
      warnings: [],
    };

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      queries.push(request.variables.query);
      sentFilters.push(request.variables.filters);

      if (queries.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstRequest = resolve;
        });
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          queries.length === 1
            ? response('OK', results)
            : response('OK', [], queries.length === 2 ? excludingTesla : unconstrained)
        ),
      });
    });

    await page.goto(url);

    // A short legend of the words the search reads as filters.
    const legend = page.locator('[data-cy="semantic-search-legend"]');

    for (const word of ['excluding', 'by', 'affecting', 'against', 'since / before']) {
      await expect(legend).toContainText(word);
    }

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

    // Each row starts with the incident's picture, or a plain box when it has none, and ends
    // with its score.
    const firstRow = page.locator('[data-cy="row"]').first();
    await expect(
      firstRow.locator('[data-cy="cell"]').first().locator('[data-cy="cloudinary-image-wrapper"]')
    ).toHaveCount(1);
    await expect(firstRow.locator('[data-cy="semantic-search-image"]')).toHaveAttribute(
      'href',
      /\/cite\/1\/?$/
    );
    await expect(
      page
        .locator('[data-cy="row"]')
        .nth(1)
        .locator('[data-cy="semantic-search-image"] [data-cy="cloudinary-image-wrapper"]')
    ).toHaveCount(0);
    await expect(firstRow.locator('[data-cy="cell"]').last()).toHaveText('0.300');

    await page.locator('[data-cy="semantic-search-score-help"]').hover();
    const scoreGuide = page.locator('[data-cy="semantic-search-score-guide"]');

    await expect(scoreGuide).toBeVisible();
    await expect(scoreGuide.locator('li')).toHaveText([
      '0.4–0.65: strong matches',
      '0.25–0.4: related but looser matches',
      'Below about 0.16: unrelated topics',
    ]);

    await page.locator('[data-cy="last-page"]').click();
    await expect(page.locator('[data-cy="row"]')).toHaveCount(5);
    await expect(page.locator('[data-cy="row"]').first()).toContainText('Incident 26');

    await page.locator('[data-cy="first-page"]').click();
    await page.locator('[data-cy="header-score"] button').first().click();
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
    await expect(page.locator('[data-cy="semantic-search-exclusion"]')).toContainText(
      'Excluding: Tesla'
    );
    await page.locator('[data-cy="semantic-search-example-3"]').click();
    await expect(page.locator('[data-cy="semantic-search-empty"]')).toBeVisible();
    await expect(page.locator('[data-cy="semantic-search-exclusion"]')).toHaveCount(0);

    expect(queries).toEqual([
      'deepfake related incidents',
      'self-driving crashes excluding tesla',
      'lawsuits against openai since 2023',
    ]);
    expect(sentFilters[2]).toEqual({ excludeEntities: [], excludeNames: [] });
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

  test('marks the entities an exclusion covers through a link', async ({ page, login }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const excludingMeta = {
      semanticText: 'social media harms',
      constraints: [
        {
          kind: 'EXCLUDE_ENTITY',
          source: 'QUERY_TEXT',
          matchedText: 'meta',
          incidentCount: 97,
          entities: [
            { entity_id: 'meta', name: 'Meta', matchedBy: 'NAME' },
            { entity_id: 'meta-ai', name: 'Meta AI', matchedBy: 'FAMILY' },
            { entity_id: 'facebook', name: 'Facebook', matchedBy: 'LINK' },
          ],
        },
      ],
      warnings: [],
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
        body: JSON.stringify(response('OK', results.slice(0, 2), excludingMeta)),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const exclusion = page.locator('[data-cy="semantic-search-exclusion"]');

    await input.fill('social media harms excluding meta');
    await page.locator('[data-cy="semantic-search-submit"]').click();

    await expect(exclusion).toContainText('Excluding: Meta');
    await expect(exclusion).toContainText('3 entities · 97 incidents');
    await expect(exclusion).toHaveAttribute('title', 'Meta, Meta AI, Facebook (linked)');
  });

  test('holds constraints as removable chips and sends them back as explicit filters', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    // "gpt" starts several names and is none of them, so only the words can bring it back.
    const gpt = (source: string) => ({
      kind: 'EXCLUDE_ENTITY',
      source,
      matchedText: 'gpt',
      incidentCount: 22,
      entities: [
        { entity_id: 'gpt-3', name: 'GPT-3', matchedBy: 'FAMILY' },
        { entity_id: 'gpt-4', name: 'GPT-4', matchedBy: 'FAMILY' },
      ],
    });

    const openai = {
      kind: 'EXCLUDE_ENTITY',
      source: 'QUERY_TEXT',
      matchedText: 'openai',
      incidentCount: 60,
      entities: [{ entity_id: 'openai', name: 'OpenAI', matchedBy: 'NAME' }],
    };

    const readAs = (constraints: unknown[]) => ({
      semanticText: 'chatbot failures',
      constraints,
      warnings: [],
    });

    // The reply to each search in turn. The server merges the filters sent with what was typed.
    const replies = [
      readAs([gpt('QUERY_TEXT')]),
      readAs([gpt('EXPLICIT_FILTER'), openai]),
      readAs([gpt('EXPLICIT_FILTER')]),
    ];
    const requests: unknown[] = [];

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      requests.push(request.variables);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', results.slice(0, 2), replies[requests.length - 1])),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const submit = page.locator('[data-cy="semantic-search-submit"]');
    const exclusion = page.locator('[data-cy="semantic-search-exclusion"]');

    await input.fill('chatbot failures excluding gpt');
    await submit.click();

    await expect(exclusion).toHaveCount(1);
    await expect(exclusion).toContainText('Excluding: gpt');
    await expect(input).toHaveValue('chatbot failures');

    await input.fill('chatbot failures excluding openai');
    await submit.click();

    await expect(exclusion).toHaveCount(2);
    await expect(exclusion.nth(1)).toContainText('Excluding: OpenAI');
    await expect(input).toHaveValue('chatbot failures');

    await exclusion
      .filter({ hasText: 'OpenAI' })
      .locator('[data-cy="semantic-search-remove-constraint"]')
      .click();

    // Each chip goes back as the words that named it, search after search, never as entity ids.
    await expect
      .poll(() => requests)
      .toEqual([
        {
          query: 'chatbot failures excluding gpt',
          filters: { excludeEntities: [], excludeNames: [] },
        },
        {
          query: 'chatbot failures excluding openai',
          filters: { excludeEntities: [], excludeNames: ['gpt'] },
        },
        { query: 'chatbot failures', filters: { excludeEntities: [], excludeNames: ['gpt'] } },
      ]);
    await expect(exclusion).toHaveCount(1);
    await expect(exclusion).toContainText('Excluding: gpt');
    await expect(exclusion).toContainText('2 entities · 22 incidents');
    await expect(input).toHaveValue('chatbot failures');
  });

  test('excludes organisations picked from the control, which shares its chips with the query', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const facets = {
      data: {
        semanticSearchFacets: {
          harmedEntities: [],
          responsibleEntities: [
            { entity_id: 'tesla', name: 'Tesla' },
            { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot' },
            { entity_id: 'uber', name: 'Uber' },
            { entity_id: 'waymo', name: 'Waymo' },
          ],
          earliestDate: '1983-01-01',
          latestDate: '2026-09-30',
        },
      },
    };

    const uber = (source: string) => ({
      kind: 'EXCLUDE_ENTITY',
      source,
      matchedText: 'uber',
      incidentCount: 12,
      entities: [{ entity_id: 'uber', name: 'Uber', matchedBy: 'NAME' }],
    });

    // A picked organisation is sent by id, which its constraint echoes, and covers its family.
    const tesla = {
      kind: 'EXCLUDE_ENTITY',
      source: 'EXPLICIT_FILTER',
      matchedText: 'tesla',
      incidentCount: 50,
      entities: [
        { entity_id: 'tesla', name: 'Tesla', matchedBy: 'NAME' },
        { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot', matchedBy: 'FAMILY' },
      ],
    };

    const readAs = (constraints: unknown[]) => ({
      semanticText: 'self-driving crashes',
      constraints,
      warnings: [],
    });

    const replies = [
      readAs([uber('QUERY_TEXT')]),
      readAs([tesla, uber('EXPLICIT_FILTER')]),
      readAs([tesla]),
      readAs([]),
    ];
    const requests: unknown[] = [];
    let facetRequests = 0;

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName === 'SemanticSearchFacets') {
        facetRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(facets),
        });
        return;
      }

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      requests.push(request.variables);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', results.slice(0, 2), replies[requests.length - 1])),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const exclusion = page.locator('[data-cy="semantic-search-exclusion"]');
    const control = page.locator('[data-cy="semantic-search-organisations"]');
    const organisation = page.locator('#semantic-search-exclude-organisations');
    const tokens = control.locator('.rbt-token');
    const option = (name: string) =>
      page.locator(
        `#semantic-search-exclude-organisations-tags .dropdown-item[aria-label="${name}"]`
      );

    await input.fill('self-driving crashes excluding uber');
    await page.locator('[data-cy="semantic-search-submit"]').click();

    // A typed exclusion shows up in the control as well as in the chips.
    await expect(exclusion).toHaveCount(1);
    await expect(tokens).toHaveCount(1);
    await expect(tokens).toContainText('Uber');

    await organisation.fill('tes');
    await option('Tesla').click();

    await expect(exclusion).toHaveCount(2);
    await expect(exclusion.filter({ hasText: 'Excluding: Tesla' })).toContainText(
      '2 entities · 50 incidents'
    );
    await expect(tokens).toHaveCount(2);
    await expect(input).toHaveValue('self-driving crashes');

    // Tesla Autopilot is already excluded with Tesla, so it is no longer offered.
    await organisation.fill('a');
    await expect(option('Waymo')).toBeVisible();
    await expect(option('Tesla')).toHaveCount(0);
    await expect(option('Tesla Autopilot')).toHaveCount(0);
    await organisation.fill('');

    // Removing from the control removes the chip too, and removing a chip clears the control.
    await tokens.filter({ hasText: 'Uber' }).locator('.rbt-token-remove-button').click();

    await expect(exclusion).toHaveCount(1);
    await expect(exclusion).toContainText('Excluding: Tesla');
    await expect(tokens).toHaveCount(1);

    await exclusion.locator('[data-cy="semantic-search-remove-constraint"]').click();

    await expect(exclusion).toHaveCount(0);
    await expect(tokens).toHaveCount(0);

    await expect
      .poll(() => requests)
      .toEqual([
        {
          query: 'self-driving crashes excluding uber',
          filters: { excludeEntities: [], excludeNames: [] },
        },
        {
          query: 'self-driving crashes',
          filters: { excludeEntities: ['tesla'], excludeNames: ['uber'] },
        },
        {
          query: 'self-driving crashes',
          filters: { excludeEntities: ['tesla'], excludeNames: [] },
        },
        { query: 'self-driving crashes', filters: { excludeEntities: [], excludeNames: [] } },
      ]);

    // The options are loaded once, however many searches follow.
    expect(facetRequests).toBe(1);
  });

  test('lists a search made only of constraints newest first, without scores', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const excludingTesla = {
      semanticText: '',
      constraints: [
        {
          kind: 'EXCLUDE_ENTITY',
          source: 'QUERY_TEXT',
          matchedText: 'tesla',
          incidentCount: 50,
          entities: [{ entity_id: 'tesla', name: 'Tesla', matchedBy: 'NAME' }],
        },
      ],
      warnings: [],
    };

    // Listed by date, newest first, as the server orders a search with nothing to rank by meaning.
    const newestFirst = [
      { incident_id: 7, title: 'Newest incident', date: '2025-06-01' },
      { incident_id: 5, title: 'Middle incident', date: '2023-02-01' },
      { incident_id: 9, title: 'Oldest incident', date: '2019-11-01' },
    ].map((incident) => ({
      score: null,
      incident: { ...incident, description: incident.title },
      image: null,
    }));

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', newestFirst, excludingTesla, 312)),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const rows = page.locator('[data-cy="row"]');

    await input.fill('incidents excluding tesla');
    await page.locator('[data-cy="semantic-search-submit"]').click();

    await expect(page.locator('[data-cy="semantic-search-count"]')).toHaveText('Showing 3 of 312');
    await expect(page.locator('[data-cy="semantic-search-exclusion"]')).toContainText(
      'Excluding: Tesla'
    );
    await expect(page.locator('[data-cy="semantic-search-semantic-text"]')).toHaveCount(0);
    await expect(input).toHaveValue('');

    const expectNewestFirst = async () => {
      await expect(rows).toHaveCount(3);

      for (const [index, title] of ['Newest', 'Middle', 'Oldest'].entries()) {
        await expect(rows.nth(index)).toContainText(`${title} incident`);
        await expect(rows.nth(index).locator('[data-cy="cell"]').last()).toHaveText('—');
      }
    };

    await expectNewestFirst();

    // Sorting by score in either direction leaves unscored results in the order they came.
    await page.locator('[data-cy="header-score"] button').first().click();
    await expectNewestFirst();

    const csvDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-cy="semantic-search-export-csv"]').click();
    const csv = await readFile((await (await csvDownloadPromise).path())!, 'utf8');

    expect(csv).toContain('"","7","2025-06-01","Newest incident"');

    const xlsxDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-cy="semantic-search-export"]').click();
    const workbook = readWorkbook(await readFile((await (await xlsxDownloadPromise).path())!));

    expect(workbook.Results[1].slice(0, 2)).toEqual(['', '7']);
  });

  test('limits a search to a period typed in the query or set in the date control', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const facets = {
      data: {
        semanticSearchFacets: {
          harmedEntities: [],
          responsibleEntities: [],
          earliestDate: '1983-09-26',
          latestDate: '2026-09-30',
        },
      },
    };

    const dateRange = (
      source: string,
      matchedText: string | null,
      dateFrom: string | null,
      dateTo: string | null,
      incidentCount: number
    ) => ({
      kind: 'DATE_RANGE',
      source,
      matchedText,
      dateFrom,
      dateTo,
      incidentCount,
      entities: [],
    });

    const readAs = (constraints: unknown[]) => ({
      semanticText: 'deepfakes',
      constraints,
      warnings: [],
    });

    // The reply to each search in turn. A date typed in the query replaces the range sent with it.
    const replies = [
      readAs([dateRange('QUERY_TEXT', 'since 2020', '2020-01-01', null, 120)]),
      readAs([dateRange('EXPLICIT_FILTER', null, '2020-01-01', '2022-12-31', 70)]),
      readAs([dateRange('QUERY_TEXT', 'in 2019', '2019-01-01', '2019-12-31', 25)]),
      readAs([]),
    ];
    const requests: unknown[] = [];

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName === 'SemanticSearchFacets') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(facets),
        });
        return;
      }

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      requests.push(request.variables);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', results.slice(0, 2), replies[requests.length - 1])),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const submit = page.locator('[data-cy="semantic-search-submit"]');
    const chip = page.locator('[data-cy="semantic-search-date-range"]');
    const dateFrom = page.locator('[data-cy="semantic-search-date-from"]');
    const dateTo = page.locator('[data-cy="semantic-search-date-to"]');
    const apply = page.locator('[data-cy="semantic-search-apply-dates"]');

    // The control offers only the days incidents span.
    await expect(dateFrom).toHaveAttribute('min', '1983-09-26');
    await expect(dateTo).toHaveAttribute('max', '2026-09-30');

    await input.fill('deepfakes since 2020');
    await submit.click();

    // A typed date becomes a chip and fills the control, and leaves the box.
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText('Since 2020');
    await expect(chip).toContainText('120 incidents');
    await expect(input).toHaveValue('deepfakes');
    await expect(dateFrom).toHaveValue('2020-01-01');
    await expect(dateTo).toHaveValue('');
    await expect(apply).toBeDisabled();

    await dateTo.fill('2022-12-31');
    await apply.click();

    await expect(chip).toContainText('2020–2022');
    await expect(chip).toContainText('70 incidents');

    await input.fill('deepfakes in 2019');
    await submit.click();

    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText('In 2019');
    await expect(dateFrom).toHaveValue('2019-01-01');
    await expect(dateTo).toHaveValue('2019-12-31');

    await chip.locator('[data-cy="semantic-search-remove-constraint"]').click();

    await expect(chip).toHaveCount(0);
    await expect(dateFrom).toHaveValue('');
    await expect(dateTo).toHaveValue('');

    // The range goes back as its bounds, search after search, and not at all once removed.
    await expect
      .poll(() => requests)
      .toEqual([
        { query: 'deepfakes since 2020', filters: { excludeEntities: [], excludeNames: [] } },
        {
          query: 'deepfakes',
          filters: {
            excludeEntities: [],
            excludeNames: [],
            dateFrom: '2020-01-01',
            dateTo: '2022-12-31',
          },
        },
        {
          query: 'deepfakes in 2019',
          filters: {
            excludeEntities: [],
            excludeNames: [],
            dateFrom: '2020-01-01',
            dateTo: '2022-12-31',
          },
        },
        { query: 'deepfakes', filters: { excludeEntities: [], excludeNames: [] } },
      ]);
  });

  test('holds inclusions and affected parties as chips and sends them back with their roles', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const developedByGoogle = {
      kind: 'INCLUDE_ENTITY',
      source: 'QUERY_TEXT',
      matchedText: 'google',
      roles: ['DEVELOPER'],
      incidentCount: 96,
      entities: [
        { entity_id: 'google', name: 'Google', matchedBy: 'NAME' },
        { entity_id: 'google-bard', name: 'Google Bard', matchedBy: 'FAMILY' },
      ],
    };

    const affectingStudents = {
      kind: 'HARMED_PARTY',
      source: 'QUERY_TEXT',
      matchedText: 'students',
      roles: ['HARMED'],
      incidentCount: 99,
      entities: [
        { entity_id: 'students', name: 'Students', matchedBy: 'NAME' },
        { entity_id: 'university-students', name: 'University students', matchedBy: 'FAMILY' },
      ],
    };

    const readAs = (constraints: unknown[]) => ({
      semanticText: 'chatbot failures',
      constraints,
      warnings: [],
    });

    const replies = [
      readAs([developedByGoogle, affectingStudents]),
      readAs([{ ...developedByGoogle, source: 'EXPLICIT_FILTER' }]),
    ];
    const requests: unknown[] = [];

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      requests.push(request.variables);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', results.slice(0, 2), replies[requests.length - 1])),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const inclusion = page.locator('[data-cy="semantic-search-inclusion"]');
    const affectedParty = page.locator('[data-cy="semantic-search-affected-party"]');
    const included = page.locator('[data-cy="semantic-search-include-organisations"] .rbt-token');
    const affected = page.locator('[data-cy="semantic-search-affected-parties"] .rbt-token');

    await input.fill('chatbot failures developed by google affecting students');
    await page.locator('[data-cy="semantic-search-submit"]').click();

    await expect(inclusion).toHaveCount(1);
    await expect(inclusion).toContainText('Developed by: Google');
    await expect(inclusion).toContainText('2 entities · 96 incidents');
    await expect(affectedParty).toContainText('Affecting: Students');
    await expect(input).toHaveValue('chatbot failures');

    // Typed constraints show up in the controls too, a role-specific one with its role.
    await expect(included).toHaveCount(1);
    await expect(included).toContainText('Google (developer)');
    await expect(affected).toHaveCount(1);
    await expect(affected).toContainText('Students');

    await affectedParty.locator('[data-cy="semantic-search-remove-constraint"]').click();

    await expect
      .poll(() => requests)
      .toEqual([
        {
          query: 'chatbot failures developed by google affecting students',
          filters: { excludeEntities: [], excludeNames: [] },
        },
        {
          query: 'chatbot failures',
          filters: {
            excludeEntities: [],
            excludeNames: [],
            include: [{ name: 'google', roles: ['DEVELOPER'] }],
          },
        },
      ]);
    await expect(affectedParty).toHaveCount(0);
    await expect(affected).toHaveCount(0);
    await expect(inclusion).toContainText('Developed by: Google');
  });

  test('applies a suggested organisation when clicked, and stops suggesting it', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const query = 'tesla autopilot crashes';

    const replies = [
      {
        semanticText: query,
        constraints: [],
        warnings: [],
        suggestions: [
          { kind: 'INCLUDE_ENTITY', value: 'tesla-autopilot', label: 'Tesla Autopilot' },
        ],
      },
      {
        semanticText: query,
        constraints: [
          {
            kind: 'INCLUDE_ENTITY',
            source: 'EXPLICIT_FILTER',
            matchedText: 'tesla-autopilot',
            roles: ['DEPLOYER', 'DEVELOPER', 'IMPLICATED'],
            incidentCount: 30,
            entities: [
              { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot', matchedBy: 'NAME' },
            ],
          },
        ],
        warnings: [],
        suggestions: [],
      },
    ];
    const requests: unknown[] = [];

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      requests.push(request.variables);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', results.slice(0, 2), replies[requests.length - 1])),
      });
    });

    await page.goto(url);

    const input = page.locator('[data-cy="semantic-search-input"]');
    const suggestion = page.locator('[data-cy="semantic-search-suggestion"]');

    await input.fill(query);
    await page.locator('[data-cy="semantic-search-submit"]').click();

    await expect(suggestion).toHaveText(['Only incidents involving Tesla Autopilot?']);
    // A mention stays part of the meaning, so the box keeps it.
    await expect(input).toHaveValue(query);

    await suggestion.click();

    await expect(page.locator('[data-cy="semantic-search-inclusion"]')).toContainText(
      'Involving: Tesla Autopilot'
    );
    await expect(suggestion).toHaveCount(0);
    await expect(input).toHaveValue(query);
    expect(requests).toEqual([
      { query, filters: { excludeEntities: [], excludeNames: [] } },
      {
        query,
        filters: {
          excludeEntities: [],
          excludeNames: [],
          include: [{ entityId: 'tesla-autopilot' }],
        },
      },
    ]);
  });

  test('keeps organisations and affected parties picked from their controls', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const facets = {
      data: {
        semanticSearchFacets: {
          responsibleEntities: [
            { entity_id: 'openai', name: 'OpenAI' },
            { entity_id: 'tesla', name: 'Tesla' },
          ],
          harmedEntities: [
            { entity_id: 'students', name: 'Students' },
            { entity_id: 'tesla-drivers', name: 'Tesla drivers' },
          ],
          earliestDate: '1983-01-01',
          latestDate: '2026-09-30',
        },
      },
    };

    const openai = {
      kind: 'INCLUDE_ENTITY',
      source: 'EXPLICIT_FILTER',
      matchedText: 'openai',
      roles: ['DEPLOYER', 'DEVELOPER', 'IMPLICATED'],
      incidentCount: 166,
      entities: [{ entity_id: 'openai', name: 'OpenAI', matchedBy: 'NAME' }],
    };

    const students = {
      kind: 'HARMED_PARTY',
      source: 'EXPLICIT_FILTER',
      matchedText: 'students',
      roles: ['HARMED'],
      incidentCount: 99,
      entities: [{ entity_id: 'students', name: 'Students', matchedBy: 'NAME' }],
    };

    const readAs = (constraints: unknown[]) => ({
      semanticText: 'essay grading',
      constraints,
      warnings: [],
    });

    const replies = [readAs([]), readAs([openai]), readAs([openai, students])];
    const requests: unknown[] = [];

    await page.route('**/graphql', async (route) => {
      const request = route.request().postDataJSON();

      if (request.operationName === 'SemanticSearchFacets') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(facets),
        });
        return;
      }

      if (request.operationName !== 'SemanticSearch') {
        await route.continue();
        return;
      }

      requests.push(request.variables);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response('OK', results.slice(0, 2), replies[requests.length - 1])),
      });
    });

    await page.goto(url);

    const option = (control: string, name: string) =>
      page.locator(`#${control}-tags .dropdown-item[aria-label="${name}"]`);

    await page.locator('[data-cy="semantic-search-input"]').fill('essay grading');
    await page.locator('[data-cy="semantic-search-submit"]').click();
    await expect(page.locator('[data-cy="semantic-search-count"]')).toBeVisible();

    await page.locator('#semantic-search-include-organisations').fill('open');
    await option('semantic-search-include-organisations', 'OpenAI').click();

    await expect(page.locator('[data-cy="semantic-search-inclusion"]')).toContainText(
      'Involving: OpenAI'
    );

    await page.locator('#semantic-search-affected-parties').fill('stud');
    await option('semantic-search-affected-parties', 'Students').click();

    await expect(page.locator('[data-cy="semantic-search-affected-party"]')).toContainText(
      'Affecting: Students'
    );
    // Picking an organisation to keep leaves the exclusion control alone.
    await expect(page.locator('[data-cy="semantic-search-organisations"] .rbt-token')).toHaveCount(
      0
    );

    await expect
      .poll(() => requests)
      .toEqual([
        { query: 'essay grading', filters: { excludeEntities: [], excludeNames: [] } },
        {
          query: 'essay grading',
          filters: { excludeEntities: [], excludeNames: [], include: [{ entityId: 'openai' }] },
        },
        {
          query: 'essay grading',
          filters: {
            excludeEntities: [],
            excludeNames: [],
            include: [{ entityId: 'openai' }, { entityId: 'students', roles: ['HARMED'] }],
          },
        },
      ]);
  });
});
