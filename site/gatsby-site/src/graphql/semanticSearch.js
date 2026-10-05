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
          reports {
            report_number
            cloudinary_id
            image_url
          }
        }
      }
      interpretation {
        semanticText
        constraints {
          kind
          source
          matchedText
          roles
          incidentCount
          dateFrom
          dateTo
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
        suggestions {
          kind
          value
          label
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
      harmedEntities {
        entity_id
        name
      }
      earliestDate
      latestDate
    }
  }
`);
