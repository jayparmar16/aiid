import React from 'react';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { constraintName, counted, entityList } from './constraintText';

// How the chip reads, from the roles the entities were looked for in.
const titleOf = ({ kind, roles }) => {
  if (kind === 'HARMED_PARTY') return 'Affecting: {{name}}';

  if (roles?.length === 1 && roles[0] === 'DEVELOPER') return 'Developed by: {{name}}';

  if (roles?.length === 1 && roles[0] === 'DEPLOYER') return 'Deployed by: {{name}}';

  return 'Involving: {{name}}';
};

/**
 * One inclusion or affected party, labelled with the entity whose name was written, listing every
 * entity it covers.
 */
export default function InclusionChip({ constraint, onRemove }) {
  const { t } = useTranslation();

  const name = constraintName(constraint);

  const harmed = constraint.kind === 'HARMED_PARTY';

  return (
    <span
      title={entityList(t, constraint.entities)}
      className="inline-flex items-center gap-2 rounded-full border border-green-300 bg-green-50 px-3 py-1 text-sm text-green-800"
      data-cy={harmed ? 'semantic-search-affected-party' : 'semantic-search-inclusion'}
    >
      <span>{t(titleOf(constraint), { name })}</span>
      <span className="text-xs text-green-700">
        {counted(t, constraint.entities.length, '1 entity', '{{count}} entities')}
        {' · '}
        {counted(t, constraint.incidentCount, '1 incident', '{{count}} incidents')}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('Stop filtering by {{name}}', { name })}
        className="-mr-1 rounded-full px-1 text-green-700 hover:bg-green-100 hover:text-green-900 focus:outline-none focus:ring-2 focus:ring-green-500"
        data-cy="semantic-search-remove-constraint"
      >
        <FontAwesomeIcon icon={faXmark} />
      </button>
    </span>
  );
}
