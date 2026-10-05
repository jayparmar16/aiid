import React from 'react';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import EntityFilter from './EntityFilter';
import { SEMANTIC_SEARCH_FACETS } from '../../graphql/semanticSearch';

/**
 * Picks organisations to include or exclude from those that occur as an alleged deployer,
 * developer or implicated system. Each control shows the chips of its kind, typed ones included,
 * and hands back the whole set of chips after every change.
 */
export default function OrganisationFilter({ chips, onChange, disabled = false }) {
  const { t } = useTranslation();

  // Loaded once per visit: Apollo's cache answers every later render without another request.
  const { data } = useQuery(SEMANTIC_SEARCH_FACETS);

  const entities = data?.semanticSearchFacets.responsibleEntities;

  return (
    <div className="flex flex-wrap gap-x-4">
      <EntityFilter
        kind="INCLUDE_ENTITY"
        entities={entities}
        chips={chips}
        onChange={onChange}
        disabled={disabled}
        inputId="semantic-search-include-organisations"
        label={t('Only organisations')}
        placeholder={t('Type an organisation or system to keep')}
        data-cy="semantic-search-include-organisations"
      />
      <EntityFilter
        kind="EXCLUDE_ENTITY"
        entities={entities}
        chips={chips}
        onChange={onChange}
        disabled={disabled}
        inputId="semantic-search-exclude-organisations"
        label={t('Exclude organisations')}
        placeholder={t('Type an organisation or system to exclude')}
        data-cy="semantic-search-organisations"
      />
    </div>
  );
}
