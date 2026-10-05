import React from 'react';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

/** The domain's name without its number: "Misinformation" for "3. Misinformation". */
export const mitDomainLabel = (domain) => domain.replace(/^\s*\d+\.\s*/, '');

/** One MIT risk domain the results are kept to, with how many incidents it has in all. */
export default function MitRiskDomainChip({ constraint, onRemove }) {
  const { t } = useTranslation();

  const label = mitDomainLabel(constraint.mitRiskDomain ?? constraint.matchedText);

  return (
    <span
      title={constraint.mitRiskDomain}
      className="inline-flex items-center gap-2 rounded-full border border-blue-300 bg-blue-50 px-3 py-1 text-sm text-blue-800"
      data-cy="semantic-search-mit-domain"
    >
      <span>{t('MIT: {{label}}', { label })}</span>
      <span className="text-xs text-blue-600">
        {constraint.incidentCount === 1
          ? t('1 incident')
          : t('{{count}} incidents', { count: constraint.incidentCount })}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('Stop filtering to MIT: {{label}}', { label })}
        className="-mr-1 rounded-full px-1 text-blue-600 hover:bg-blue-100 hover:text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        data-cy="semantic-search-remove-constraint"
      >
        <FontAwesomeIcon icon={faXmark} />
      </button>
    </span>
  );
}
