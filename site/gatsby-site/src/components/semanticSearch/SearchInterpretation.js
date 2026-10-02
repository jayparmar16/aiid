import React from 'react';
import { useTranslation } from 'react-i18next';

// Spells out "1 entity" or "6 entities", since these strings have no plural translations.
const counted = (t, count, one, many) => (count === 1 ? t(one) : t(many, { count }));

// Marks entities covered through an editor's link rather than the written name, which would
// otherwise look out of place in the list (Facebook under "Excluding: Meta").
const entityList = (t, entities) =>
  entities
    .map((entity) =>
      entity.matchedBy === 'LINK' ? t('{{name}} (linked)', { name: entity.name }) : entity.name
    )
    .join(', ');

/** One exclusion, labelled with the entity whose name was written, listing every entity it covers. */
function ExclusionChip({ constraint }) {
  const { t } = useTranslation();

  const named = constraint.entities.find((entity) => entity.matchedBy === 'NAME');

  return (
    <span
      title={entityList(t, constraint.entities)}
      className="inline-flex items-center gap-2 rounded-full border border-red-300 bg-red-50 px-3 py-1 text-sm text-red-800"
      data-cy="semantic-search-exclusion"
    >
      <span>{t('Excluding: {{name}}', { name: named?.name ?? constraint.matchedText })}</span>
      <span className="text-xs text-red-600">
        {counted(t, constraint.entities.length, '1 entity', '{{count}} entities')}
        {' · '}
        {counted(t, constraint.incidentCount, '1 incident', '{{count}} incidents')}
      </span>
    </span>
  );
}

/**
 * Shows how a query was read: the part ranked by meaning, each constraint applied to the results,
 * and anything that could not be applied. A query without constraints needs no explanation.
 */
export default function SearchInterpretation({ interpretation }) {
  const { t } = useTranslation();

  if (!interpretation) return null;

  const { semanticText, constraints, warnings } = interpretation;

  if (constraints.length === 0 && warnings.length === 0) return null;

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
        {constraints.map((constraint, index) => (
          <ExclusionChip key={index} constraint={constraint} />
        ))}
      </div>
      {warnings.map((warning, index) => (
        <p key={index} className="mt-2 text-sm text-amber-700" data-cy="semantic-search-warning">
          {t('Could not exclude “{{text}}”: no organisation or system has that name.', {
            text: warning.text,
          })}
        </p>
      ))}
    </div>
  );
}
