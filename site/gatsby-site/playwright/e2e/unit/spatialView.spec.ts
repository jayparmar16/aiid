import { test, expect, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { transformSync } from '@babel/core';

const compile = (file: string) =>
  transformSync(readFileSync(path.resolve(file), 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs'],
  })!.code!;
const visualization = compile('src/components/cite/TsneVisualization.js');
const template = compile('src/templates/tsneVisualizationPage.js');

// Real page and plot components, with external styling/navigation/zoom/API boundaries mocked.
async function mount(page: Page, incidents: unknown[], selected = -1) {
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
  );
  await page.goto(`http://spatial.test/?incident=${selected}`);
  for (const file of ['react/umd/react.development.js', 'react-dom/umd/react-dom.development.js']) {
    await page.addScriptTag({ content: readFileSync(path.resolve('node_modules', file), 'utf8') });
  }
  await page.evaluate(
    ({ visualizationCode, templateCode, rows }) => {
      const w = window as any;
      const React = w.React;
      const color: any = {
        toString: () => '#ffffff',
        hex: () => '#ffffff',
        hue: () => 0,
        isDark: () => false,
      };
      for (const method of ['opaquer', 'darken', 'desaturate']) color[method] = () => color;
      const Color = Object.assign(() => color, { hsv: () => color });
      w.zoom = {};
      const dependencies: Record<string, any> = {
        react: React,
        'flowbite-react': {
          Select: ({ children, ...props }: any) => React.createElement('select', props, children),
        },
        '@apollo/client': {
          gql: (query: unknown) => query,
          useApolloClient: () => ({
            query: () => {
              throw new Error('No live API expected');
            },
          }),
        },
        '../../utils/cloudinary': { Image: () => null },
        'react-zoom-pan-pinch': {
          TransformWrapper: ({ children, ...props }: any) => {
            w.zoom = props;
            return children({ state: { scale: 1 } });
          },
          TransformComponent: ({ children }: any) => React.createElement('div', null, children),
        },
        color: Color,
        'plugins/gatsby-theme-i18n': {
          LocalizedLink: ({ to, children, ...props }: any) =>
            React.createElement('a', { ...props, href: to }, children),
        },
        'react-i18next': {
          Trans: ({ children }: any) => React.createElement(React.Fragment, null, children),
          useTranslation: () => ({ t: (text: string) => text }),
        },
        'components/ui/ApiLoginRequired': () => null,
        'hooks/useApiAccess': () => ({ hasApiAccess: false }),
        'components/HeadContent': () => null,
      };
      const load = (code: string) => {
        const module = { exports: {} as any };
        new Function('require', 'module', 'exports', code)(
          (name: string) => {
            if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
            return dependencies[name];
          },
          module,
          module.exports
        );
        return module.exports.default;
      };
      dependencies['components/cite/TsneVisualization'] = load(visualizationCode);
      const Page = load(templateCode);
      w.ReactDOM.createRoot(document.getElementById('root')).render(
        React.createElement(Page, {
          pageContext: {
            spatialIncidents: rows,
            classifications: [],
            taxa: [],
            csetClassifications: [],
          },
        })
      );
    },
    { visualizationCode: visualization, templateCode: template, rows: incidents }
  );
}

const incidents = [
  { incident_id: 1, title: 'First', tsne: { x: 0.25, y: -0.5 } },
  { incident_id: 2, title: 'Second', tsne: { x: -0.1, y: 0.2 } },
];

test('renders the fresh coordinate contract and overview-based explanation', async ({ page }) => {
  await mount(page, incidents, 1);
  await expect(page.locator('[data-cy="tsne-plotpoint"]')).toHaveCount(2);
  await expect(page.locator('#spatial-incident-1')).toHaveClass(/current/);
  const zoom = await page.evaluate(() => (window as any).zoom);
  expect(zoom.initialScale).toBe(2);
  expect(zoom.initialPositionX).toBe(-625);
  expect(zoom.initialPositionY).toBe(-250);
  await expect(page.getByText(/computed from incident titles and descriptions/)).toBeVisible();
});

test('shows the available plot when the requested incident has no compatible vector', async ({
  page,
}) => {
  await mount(page, incidents, 99);
  await expect(page.locator('[data-cy="tsne-plotpoint"]')).toHaveCount(2);
  await expect(page.locator('[data-cy="tsne-plotpoint"].current')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).zoom.initialScale)).toBe(1);
});

test('explains an empty compatible corpus instead of showing legacy points', async ({ page }) => {
  await mount(page, []);
  await expect(page.locator('[data-cy="spatial-empty"]')).toContainText(
    'compatible overview embeddings'
  );
  await expect(page.locator('[data-cy="tsne-plotpoint"]')).toHaveCount(0);
});
