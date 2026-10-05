import React, { useEffect, useState } from 'react';
import { useQuery } from '@apollo/client';
import { Button } from 'flowbite-react';
import { useTranslation } from 'react-i18next';
import { SEMANTIC_SEARCH_FACETS } from '../../graphql/semanticSearch';

/**
 * Sets the period a search is limited to. It shows the range currently held, typed ones included,
 * and applies a change only on request, since a date input reports every keystroke of a year as a
 * complete date. Clearing both days and applying removes the range.
 */
export default function DateRangeFilter({ range, onChange, disabled = false }) {
  const { t } = useTranslation();

  // The same cached query as the organisation control, so it adds no request.
  const { data } = useQuery(SEMANTIC_SEARCH_FACETS);

  const earliest = data?.semanticSearchFacets.earliestDate ?? undefined;

  const latest = data?.semanticSearchFacets.latestDate ?? undefined;

  const heldFrom = range?.dateFrom ?? '';

  const heldTo = range?.dateTo ?? '';

  const [draft, setDraft] = useState({ dateFrom: heldFrom, dateTo: heldTo });

  // A range typed in the query or removed as a chip replaces whatever was being edited.
  useEffect(() => setDraft({ dateFrom: heldFrom, dateTo: heldTo }), [heldFrom, heldTo]);

  const unchanged = draft.dateFrom === heldFrom && draft.dateTo === heldTo;

  const apply = () =>
    onChange(
      draft.dateFrom || draft.dateTo
        ? { dateFrom: draft.dateFrom || null, dateTo: draft.dateTo || null }
        : null
    );

  const input = (field, label) => (
    <label className="flex items-center gap-2 text-sm">
      {label}
      <input
        type="date"
        value={draft[field]}
        min={earliest}
        max={latest}
        disabled={disabled}
        onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
        className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        data-cy={`semantic-search-${field === 'dateFrom' ? 'date-from' : 'date-to'}`}
      />
    </label>
  );

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3" data-cy="semantic-search-dates">
      <span className="text-sm">{t('Incident date')}</span>
      {input('dateFrom', t('From'))}
      {input('dateTo', t('To'))}
      <Button
        size="xs"
        color="light"
        disabled={disabled || unchanged}
        onClick={apply}
        data-cy="semantic-search-apply-dates"
      >
        {t('Apply dates')}
      </Button>
    </div>
  );
}
