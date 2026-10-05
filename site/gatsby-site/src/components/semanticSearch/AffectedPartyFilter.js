import React from 'react';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import EntityFilter from './EntityFilter';
import { SEMANTIC_SEARCH_FACETS } from '../../graphql/semanticSearch';

/**
 * Picks groups that were allegedly harmed or nearly harmed, keeping only the incidents affecting
 * any of them. It shares its chips with "affecting …" typed in the query.
 */
export default function AffectedPartyFilter({ chips, onChange, disabled = false }) {
  const { t } = useTranslation();

  // The same cached facets as the organisation control, so this costs no extra request.
  const { data } = useQuery(SEMANTIC_SEARCH_FACETS);

  return (
    <EntityFilter
      kind="HARMED_PARTY"
      entities={data?.semanticSearchFacets.harmedEntities}
      chips={chips}
      onChange={onChange}
      disabled={disabled}
      inputId="semantic-search-affected-parties"
      label={t('Affected parties')}
      placeholder={t('Type a group that was harmed')}
      data-cy="semantic-search-affected-parties"
    />
  );
}
