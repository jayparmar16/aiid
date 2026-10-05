import React from 'react';
import { useTranslation } from 'react-i18next';

// How each kind of suggestion asks to be applied.
const questions = { INCLUDE_ENTITY: 'Only incidents involving {{label}}?' };

/**
 * Constraints the query hints at without asking for them, such as an organisation mentioned without
 * "by". Clicking one applies it.
 */
export default function SuggestionChips({ suggestions = [], onAccept, disabled = false }) {
  const { t } = useTranslation();

  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4" data-cy="semantic-search-suggestions">
      {suggestions.map((suggestion) => (
        <button
          key={`${suggestion.kind}:${suggestion.value}`}
          type="button"
          disabled={disabled}
          onClick={() => onAccept(suggestion)}
          className="rounded-full border border-dashed border-blue-400 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          data-cy="semantic-search-suggestion"
        >
          {t(questions[suggestion.kind] ?? '{{label}}?', { label: suggestion.label })}
        </button>
      ))}
    </div>
  );
}
