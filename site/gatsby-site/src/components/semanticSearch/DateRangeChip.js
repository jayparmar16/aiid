import React from 'react';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

// The year when a bound falls on that edge of a year, so whole years read as years.
const yearAt = (date, edge) => (date?.endsWith(edge) ? date.slice(0, 4) : null);

/**
 * Names a date range the way it is usually written ("Since 2020", "2019–2021"), whether it was
 * typed or set in the date control, falling back to the exact days.
 */
export const describeDateRange = (t, { dateFrom, dateTo }) => {
  const fromYear = yearAt(dateFrom, '-01-01');

  const toYear = yearAt(dateTo, '-12-31');

  if (dateFrom && dateTo) {
    if (fromYear && toYear) {
      return fromYear === toYear
        ? t('In {{year}}', { year: fromYear })
        : t('{{from}}–{{to}}', { from: fromYear, to: toYear });
    }

    return t('{{from}} to {{to}}', { from: dateFrom, to: dateTo });
  }

  return dateFrom
    ? t('Since {{date}}', { date: fromYear ?? dateFrom })
    : t('Up to {{date}}', { date: toYear ?? dateTo });
};

/** The date range a search was limited to, with the number of incidents dated within it. */
export default function DateRangeChip({ constraint, onRemove }) {
  const { t } = useTranslation();

  const label = describeDateRange(t, constraint);

  return (
    <span
      title={[constraint.dateFrom, constraint.dateTo].map((date) => date ?? '…').join(' – ')}
      className="inline-flex items-center gap-2 rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-sm text-blue-800"
      data-cy="semantic-search-date-range"
    >
      <span>{label}</span>
      <span className="text-xs text-blue-600">
        {constraint.incidentCount === 1
          ? t('1 incident')
          : t('{{count}} incidents', { count: constraint.incidentCount })}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('Remove the date range {{label}}', { label })}
        className="-mr-1 rounded-full px-1 text-blue-600 hover:bg-blue-100 hover:text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        data-cy="semantic-search-remove-constraint"
      >
        <FontAwesomeIcon icon={faXmark} />
      </button>
    </span>
  );
}
