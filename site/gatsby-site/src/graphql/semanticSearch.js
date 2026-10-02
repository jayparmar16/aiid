import { gql } from '../../server/generated';

export const SEMANTIC_SEARCH = gql(`
  query SemanticSearch($query: String!, $limit: Int) {
    semanticSearch(query: $query, limit: $limit) {
      status
      results {
        score
        incident {
          incident_id
          title
          date
          description
        }
      }
      interpretation {
        semanticText
        constraints {
          kind
          matchedText
          incidentCount
          entities {
            entity_id
            name
            matchedBy
          }
        }
        warnings {
          code
          text
        }
      }
    }
  }
`);
