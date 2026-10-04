import React from 'react';
import { usePagination, useSortBy, useTable } from 'react-table';
import { useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSort, faSortDown, faSortUp } from '@fortawesome/free-solid-svg-icons';
import Link from 'components/ui/Link';
import Table, { formatDateField } from 'components/ui/Table';

// Orders scores as numbers, since the default alphanumeric sort misorders decimals. Results
// listed by date have no score: they stay below scored ones and in the order they came, newest
// first, whichever way the column is sorted. The table reverses ties when sorting descending, so
// unscored rows are compared by position instead.
const byScore = (left, right, columnId, desc) => {
  const leftScore = left.values[columnId];

  const rightScore = right.values[columnId];

  const direction = desc ? -1 : 1;

  if (leftScore == null && rightScore == null) return (left.index - right.index) * direction;

  if (leftScore == null || rightScore == null) return (leftScore == null ? 1 : -1) * direction;

  return leftScore - rightScore;
};

// Header that toggles sorting on click and shows the current sort direction.
function SortHeader({ column }) {
  const icon = column.isSorted ? (column.isSortedDesc ? faSortDown : faSortUp) : faSort;

  return (
    <button
      type="button"
      {...column.getSortByToggleProps()}
      className="flex items-center gap-1 uppercase text-left"
    >
      {column.title}
      {column.canSort && <FontAwesomeIcon icon={icon} className="text-gray-400" />}
    </button>
  );
}

/**
 * Lists search results with sortable columns and pagination, rendered through the shared Table.
 * Rows start sorted by score, best match first. Unscored results keep the order the search gave.
 */
export default function SemanticSearchTable({ results }) {
  const { t } = useTranslation();

  const data = React.useMemo(
    () => results.map(({ score, incident }) => ({ score, ...incident })),
    [results]
  );

  const columns = React.useMemo(
    () => [
      {
        title: t('Score'),
        accessor: 'score',
        sortType: byScore,
        sortDescFirst: true,
        // A dash rather than a blank, so a result listed by date doesn't read as a weak match.
        Cell: ({ value }) => (value == null ? '—' : value.toFixed(3)),
      },
      {
        title: t('Incident ID'),
        accessor: 'incident_id',
        sortType: 'basic',
        Cell: ({ value }) => <Link to={`/cite/${value}`}>{value}</Link>,
      },
      {
        title: t('Date'),
        accessor: 'date',
        Cell: ({ value }) => formatDateField(value),
      },
      { title: t('Title'), accessor: 'title' },
      { title: t('Description'), accessor: 'description', disableSortBy: true },
    ],
    [t]
  );

  const table = useTable(
    {
      columns,
      data,
      defaultColumn: { Header: SortHeader },
      initialState: { sortBy: [{ id: 'score', desc: true }], pageSize: 25 },
    },
    useSortBy,
    usePagination
  );

  return <Table table={table} />;
}
