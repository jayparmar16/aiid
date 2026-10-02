import { expect } from '@playwright/test';
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

  test('holds constraints as removable chips and sends them back as explicit filters', async ({
    page,
    login,
  }) => {
    await login({ customData: { roles: ['subscriber'] } });

    const tesla = {
      kind: 'EXCLUDE_ENTITY',
      matchedText: 'tesla',
      incidentCount: 50,
      entities: [
        { entity_id: 'tesla', name: 'Tesla', matchedBy: 'NAME' },
        { entity_id: 'tesla-autopilot', name: 'Tesla Autopilot', matchedBy: 'FAMILY' },
      ],
    };

    const waymo = {
      kind: 'EXCLUDE_ENTITY',
      matchedText: 'waymo',
      incidentCount: 12,
      entities: [{ entity_id: 'waymo', name: 'Waymo', matchedBy: 'NAME' }],
    };

    const readAs = (constraints: unknown[]) => ({
      semanticText: 'self-driving car incidents',
      constraints,
      warnings: [],
    });

    // The reply to each search in turn. The server merges the filters sent with what was typed.
    const replies = [readAs([tesla]), readAs([tesla, waymo]), readAs([waymo])];
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

    await input.fill('self-driving car incidents excluding tesla');
    await submit.click();

    await expect(exclusion).toHaveCount(1);
    await expect(exclusion).toContainText('Excluding: Tesla');
    await expect(input).toHaveValue('self-driving car incidents');

    await input.fill('self-driving car incidents excluding waymo');
    await submit.click();

    await expect(exclusion).toHaveCount(2);
    await expect(exclusion.nth(1)).toContainText('Excluding: Waymo');
    await expect(input).toHaveValue('self-driving car incidents');

    await exclusion
      .filter({ hasText: 'Tesla' })
      .locator('[data-cy="semantic-search-remove-constraint"]')
      .click();

    // Each chip goes back as one filter on its first entity, never one per entity it covers.
    await expect
      .poll(() => requests)
      .toEqual([
        { query: 'self-driving car incidents excluding tesla', filters: { excludeEntities: [] } },
        {
          query: 'self-driving car incidents excluding waymo',
          filters: { excludeEntities: ['tesla'] },
        },
        { query: 'self-driving car incidents', filters: { excludeEntities: ['waymo'] } },
      ]);
    await expect(exclusion).toHaveCount(1);
    await expect(exclusion).toContainText('Excluding: Waymo');
    await expect(input).toHaveValue('self-driving car incidents');
  });
});
