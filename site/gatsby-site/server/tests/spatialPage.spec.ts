export {};

const { updateTsneInDatabase } = require('../../src/utils/updateTsne');
const createSpatialPage = require('../../page-creators/createTsneVisualizationPage');

jest.mock('../../src/utils/updateTsne', () => ({ updateTsneInDatabase: jest.fn() }));
jest.mock('../../config', () => ({ i18n: { availableLanguages: ['en', 'es'] } }));
jest.mock('../../i18n', () => ({
  switchLocalizedPath: ({ newLang, path }: any) => `/${newLang}/${path}`,
}));

describe('spatial page build context', () => {
  const positions = [
    { incident_id: 1, tsne: { x: 0.1, y: -0.2 } },
    { incident_id: 2, tsne: { x: -0.3, y: 0.4 } },
  ];
  let graphql: jest.Mock;
  let createPage: jest.Mock;
  const reporter = { warn: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    updateTsneInDatabase.mockResolvedValue(positions);
    graphql = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          allMongodbAiidprodIncidents: {
            nodes: [
              { incident_id: 1, title: 'Existing', tsne: { x: 0.9, y: 0.9 } },
              { incident_id: 2, title: 'Newly embedded' },
              { incident_id: 3, title: 'Legacy only', tsne: { x: 0.8, y: 0.8 } },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          allMongodbAiidprodClassifications: {
            nodes: [{ publish: true, namespace: 'CSETv1' }, { publish: false }],
          },
        },
      })
      .mockResolvedValueOnce({
        data: { allMongodbAiidprodTaxa: { nodes: [{ namespace: 'CSETv1' }] } },
      });
    createPage = jest.fn();
  });

  it('uses fresh coordinates, includes newly embedded incidents, and excludes legacy-only incidents in every locale', async () => {
    await createSpatialPage(graphql, createPage, { reporter });
    expect(createPage.mock.calls.map(([page]) => page.path)).toEqual([
      '/en/summaries/spatial',
      '/es/summaries/spatial',
    ]);
    for (const [page] of createPage.mock.calls) {
      expect(page.context.spatialIncidents).toEqual([
        { incident_id: 1, title: 'Existing', tsne: positions[0].tsne },
        { incident_id: 2, title: 'Newly embedded', tsne: positions[1].tsne },
      ]);
      expect(page.context.classifications).toEqual([{ publish: true, namespace: 'CSETv1' }]);
      expect(page.context.taxa).toEqual([{ namespace: 'CSETv1' }]);
    }
    expect(graphql.mock.calls[0][0]).not.toContain('filter: { tsne:');
    expect(graphql.mock.calls[1][0]).toContain('in: [1,2]');
  });

  it('builds an explicitly empty view without reusing old coordinates when no corpus is available', async () => {
    updateTsneInDatabase.mockResolvedValue([]);
    await createSpatialPage(graphql, createPage, { reporter });
    expect(reporter.warn).toHaveBeenCalledWith(expect.stringContaining('no legacy fallback'));
    expect(
      createPage.mock.calls.every(([page]) => page.context.spatialIncidents.length === 0)
    ).toBe(true);
  });

  it('propagates projection failures rather than publishing stale coordinates', async () => {
    updateTsneInDatabase.mockRejectedValue(new Error('projection failed'));
    await expect(createSpatialPage(graphql, createPage, { reporter })).rejects.toThrow(
      'projection failed'
    );
    expect(graphql).not.toHaveBeenCalled();
    expect(createPage).not.toHaveBeenCalled();
  });

  it('reports failed incident queries without creating pages', async () => {
    graphql.mockReset().mockResolvedValue({ errors: [new Error('query failed')] });
    await expect(createSpatialPage(graphql, createPage, { reporter })).rejects.toThrow(
      'Could not retrieve incidents'
    );
    expect(createPage).not.toHaveBeenCalled();
  });
});
