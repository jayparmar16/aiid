import React from 'react';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { SEMANTIC_SEARCH_FACETS } from '../../graphql/semanticSearch';
import { mitDomainLabel } from './MitRiskDomainChip';

/**
 * Keeps the results to the MIT risk domains ticked, any of them. It shows the same chips as the
 * interpretation, so ticking a box, accepting a suggestion and removing a chip all edit one set of
 * domains, and it hands back every chip after each change.
 */
export default function MitRiskDomainFilter({ chips, onChange, disabled = false }) {
  const { t } = useTranslation();

  // Shares the organisation control's request, which Apollo's cache answers after the first.
  const { data } = useQuery(SEMANTIC_SEARCH_FACETS);

  const domains = data?.semanticSearchFacets.mitRiskDomains ?? [];

  const selected = new Set(chips.flatMap(({ filter }) => filter.mitRiskDomain ?? []));

  const toggle = (domain) =>
    onChange(
      selected.has(domain)
        ? chips.filter(({ filter }) => filter.mitRiskDomain !== domain)
        : [...chips, { filter: { mitRiskDomain: domain } }]
    );

  if (domains.length === 0) return null;

  return (
    <fieldset className="mb-4" data-cy="semantic-search-mit-domains">
      <legend className="block text-sm mb-1">{t('MIT risk domains')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {domains.map((domain) => (
          <label key={domain} className="inline-flex items-center gap-2 text-sm" title={domain}>
            <input
              type="checkbox"
              value={domain}
              checked={selected.has(domain)}
              disabled={disabled}
              onChange={() => toggle(domain)}
              className="rounded border-gray-300"
              data-cy="semantic-search-mit-domain-option"
            />
            {mitDomainLabel(domain)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
