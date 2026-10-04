import { gql } from '../../server/generated';

export const SEMANTIC_SEARCH = gql(`
  query SemanticSearch($query: String!, $limit: Int, $filters: SemanticSearchFilters) {
    semanticSearch(query: $query, limit: $limit, filters: $filters) {
      status
      totalCount
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
          source
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

export const SEMANTIC_SEARCH_FACETS = gql(`
  query SemanticSearchFacets {
    semanticSearchFacets {
      responsibleEntities {
        entity_id
        name
      }
    }
  }
`);
