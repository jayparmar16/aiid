import React from 'react';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import DateRangeChip from './DateRangeChip';
import InclusionChip from './InclusionChip';
import SuggestionChip from './SuggestionChip';
import { constraintName, counted, entityList } from './constraintText';

/** One exclusion, labelled with the entity whose name was written, listing every entity it covers. */
function ExclusionChip({ constraint, onRemove }) {
  const { t } = useTranslation();

  const name = constraintName(constraint);

  return (
    <span
      title={entityList(t, constraint.entities)}
      className="inline-flex items-center gap-2 rounded-full border border-red-300 bg-red-50 px-3 py-1 text-sm text-red-800"
      data-cy="semantic-search-exclusion"
    >
      <span>{t('Excluding: {{name}}', { name })}</span>
      <span className="text-xs text-red-600">
        {counted(t, constraint.entities.length, '1 entity', '{{count}} entities')}
        {' · '}
        {counted(t, constraint.incidentCount, '1 incident', '{{count}} incidents')}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('Stop excluding {{name}}', { name })}
        className="-mr-1 rounded-full px-1 text-red-600 hover:bg-red-100 hover:text-red-900 focus:outline-none focus:ring-2 focus:ring-red-500"
        data-cy="semantic-search-remove-constraint"
      >
        <FontAwesomeIcon icon={faXmark} />
      </button>
    </span>
  );
}

// The chip for each kind of constraint. Exclusions were the first kind, so they are the default.
const chips = {
  EXCLUDE_ENTITY: ExclusionChip,
  INCLUDE_ENTITY: InclusionChip,
  HARMED_PARTY: InclusionChip,
  DATE_RANGE: DateRangeChip,
};

// Why a filter could not be applied, by warning code. Anything else is an unrecognised exclusion.
const warningTexts = {
  UNKNOWN_ENTITY: 'Could not filter by “{{text}}”: no organisation, system or group has that id.',
  UNRECOGNISED_INCLUSION:
    'Could not filter by “{{text}}”: nothing involved in an incident has that name.',
  INVALID_DATE: 'Could not filter by “{{text}}”: dates are written as YYYY-MM-DD.',
};

/**
 * Shows how a query was read: the part ranked by meaning, each constraint applied to the results,
 * filters the query hints at, and anything that could not be applied. Each constraint can be
 * removed and each suggestion accepted, which searches again. A query without any of these needs
 * no explanation.
 */
export default function SearchInterpretation({
  semanticText,
  constraints,
  warnings = [],
  suggestions = [],
  onRemove,
  onAccept,
}) {
  const { t } = useTranslation();

  if (constraints.length === 0 && warnings.length === 0 && suggestions.length === 0) return null;

  return (
    <div className="mb-4" data-cy="semantic-search-interpretation">
      <div className="flex flex-wrap items-center gap-2">
        {semanticText && (
          <span
            className="rounded-full border border-gray-300 bg-gray-50 px-3 py-1 text-sm text-gray-800"
            data-cy="semantic-search-semantic-text"
          >
            {t('Searching: {{text}}', { text: semanticText })}
          </span>
        )}
        {constraints.map((constraint, index) => {
          const Chip = chips[constraint.kind] ?? ExclusionChip;

          return <Chip key={index} constraint={constraint} onRemove={() => onRemove(constraint)} />;
        })}
        {suggestions.map((suggestion) => (
          <SuggestionChip
            key={`${suggestion.kind}:${suggestion.value}`}
            suggestion={suggestion}
            onAccept={() => onAccept(suggestion)}
          />
        ))}
      </div>
      {warnings.map((warning, index) => (
        <p key={index} className="mt-2 text-sm text-amber-700" data-cy="semantic-search-warning">
          {t(
            warningTexts[warning.code] ??
              'Could not exclude “{{text}}”: no organisation or system has that name.',
            { text: warning.text }
          )}
        </p>
      ))}
    </div>
  );
}
