import React from 'react';
import { useTranslation } from 'react-i18next';

/** A filter the query hints at, applied only when clicked. */
export default function SuggestionChip({ suggestion, onAccept }) {
  const { t } = useTranslation();

  const text =
    suggestion.kind === 'MIT_RISK_DOMAIN'
      ? t('Filter to MIT: {{label}}?', { label: suggestion.label })
      : t('Only incidents involving {{label}}?', { label: suggestion.label });

  return (
    <button
      type="button"
      onClick={onAccept}
      className="rounded-full border border-dashed border-blue-400 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
      data-cy="semantic-search-suggestion"
    >
      {text}
    </button>
  );
}
