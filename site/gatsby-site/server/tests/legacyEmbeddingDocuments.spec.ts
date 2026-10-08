import { readFileSync } from 'fs';
import path from 'path';
import { DocumentNode, parse, print, visit } from 'graphql';
import { gql } from '../generated/gql';

describe('legacy embedding GraphQL document compatibility', () => {
  it.each(['incidents.js', 'reports.js'])(
    'keeps generated %s documents synchronized and only reads vectors in history',
    (file) => {
      const source = readFileSync(path.resolve(__dirname, '../../src/graphql', file), 'utf8');
      const documents = [...source.matchAll(/gql\(`([\s\S]*?)`\)/g)].map((match) => match[1]);
      expect(documents.length).toBeGreaterThan(0);
      let historicalReads = 0;
      for (const query of documents) {
        const parsed = parse(query);
        const generated = gql(query) as DocumentNode;
        // The client preset requires exact query strings; an outdated map returns {} at runtime.
        expect(generated.kind).toBe('Document');
        expect(print(generated)).toBe(print(parsed));
        let embeddingFields = 0;
        visit(parsed, {
          Field: (node) => {
            if (node.name.value === 'embedding') embeddingFields++;
          },
        });
        const isHistory = /query Find(?:Incident|Report)History\b/.test(query);
        expect(embeddingFields).toBe(isHistory ? 1 : 0);
        if (isHistory) historicalReads++;
      }
      expect(historicalReads).toBe(1);
    }
  );
});
