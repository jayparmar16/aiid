import React, { useEffect, useState } from 'react';
import { Button } from 'flowbite-react';
import { Trans } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFileCsv, faFileExcel } from '@fortawesome/free-solid-svg-icons';

// Makes a short, filesystem-safe name fragment out of the query text.
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'results';

// Parses a YYYY-MM-DD incident date as UTC midnight so the day cannot shift with the time zone.
const toDate = (value) => {
  const [year, month, day] = String(value || '')
    .split('-')
    .map(Number);

  return year && month && day ? new Date(Date.UTC(year, month - 1, day)) : null;
};

const header = (value) => ({ value, fontWeight: 'bold' });

/**
 * Describes each workbook column for the current results. Scores and incident IDs are written as
 * numbers and dates as real dates, so the file sorts and filters correctly in Excel. Links point
 * at whichever site the user is browsing.
 */
const buildColumns = (origin) => [
  {
    header: header('Score'),
    width: 8,
    cell: (row) => ({ value: row.score, type: Number, format: '0.000' }),
  },
  {
    header: header('Incident ID'),
    width: 12,
    cell: (row) => ({ value: row.incident.incident_id, type: Number }),
  },
  {
    header: header('Date'),
    width: 12,
    cell: (row) => {
      const date = toDate(row.incident.date);

      return date
        ? { value: date, type: Date, format: 'yyyy-mm-dd' }
        : { value: row.incident.date || '' };
    },
  },
  {
    header: header('Title'),
    width: 60,
    cell: (row) => ({ value: row.incident.title || '', wrap: true }),
  },
  {
    header: header('Description'),
    width: 100,
    cell: (row) => ({ value: row.incident.description || '', wrap: true }),
  },
  {
    header: header('URL'),
    width: 45,
    cell: (row) => ({ value: `${origin}/cite/${row.incident.incident_id}` }),
  },
];

// Readable names for the constraint kinds and sources the page knows. Anything else is written as
// the API names it, so constraints added to the search later still export.
const kindLabels = {
  EXCLUDE_ENTITY: 'Excluding',
  DATE_RANGE: 'Date range',
  MIT_RISK_DOMAIN: 'MIT risk domain',
};

const sourceLabels = { QUERY_TEXT: 'Query text' };

// Constraint fields with a column of their own. Every other field gets a column named after it.
const constraintFields = [
  '__typename',
  'kind',
  'matchedText',
  'source',
  'entities',
  'incidentCount',
];

// Writes any field value as text, whatever shape a newer constraint field has.
const toText = (value) => {
  if (value == null) return '';

  if (Array.isArray(value)) return value.map(toText).join(', ');

  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

const searchColumns = [{ width: 24 }, { width: 45 }, { width: 14 }, { width: 60 }, { width: 10 }];

/**
 * Describes how the results were produced, so a colleague can understand and reproduce them: the
 * submitted text, the part ranked by meaning, every constraint applied and anything that could not
 * be applied. Sections without entries say "None" rather than disappearing.
 */
const buildSearchSheet = ({ query, interpretation, searchedAt }) => {
  const constraints = interpretation?.constraints ?? [];

  const warnings = interpretation?.warnings ?? [];

  const otherFields = [
    ...new Set(constraints.flatMap((constraint) => Object.keys(constraint))),
  ].filter(
    (field) =>
      !constraintFields.includes(field) &&
      constraints.some((constraint) => toText(constraint[field]) !== '')
  );

  const constraintRows = constraints.map((constraint) => [
    kindLabels[constraint.kind] ?? toText(constraint.kind),
    { value: constraint.matchedText ?? '', wrap: true },
    sourceLabels[constraint.source] ?? toText(constraint.source),
    { value: (constraint.entities ?? []).map((entity) => entity.name).join(', '), wrap: true },
    constraint.incidentCount ?? null,
    ...otherFields.map((field) => toText(constraint[field])),
  ]);

  const warningRows = warnings.map((warning) => [
    warning.code,
    { value: warning.text, wrap: true },
  ]);

  return [
    [header('Query'), { value: query, wrap: true }],
    [header('Semantic text'), { value: interpretation?.semanticText ?? '', wrap: true }],
    // Excel cells carry no time zone, so the zone is written out.
    [header('Searched at'), `${searchedAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`],
    [],
    ['Constraint', 'Matched text', 'Source', 'Entities', 'Incidents', ...otherFields].map(header),
    ...(constraintRows.length > 0 ? constraintRows : [['None']]),
    [],
    [header('Warning'), header('Text')],
    ...(warningRows.length > 0 ? warningRows : [['None']]),
  ];
};

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const buildCsv = (results, origin) => {
  const rows = [
    ['Score', 'Incident ID', 'Date', 'Title', 'Description', 'URL'],
    ...results.map((row) => [
      row.score,
      row.incident.incident_id,
      row.incident.date || '',
      row.incident.title || '',
      row.incident.description || '',
      `${origin}/cite/${row.incident.incident_id}`,
    ]),
  ];

  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
};

/**
 * Exports every returned result as CSV or Excel without depending on table pagination. The Excel
 * file also describes the search that produced the results.
 */
export default function ExcelExport({ results, query, interpretation }) {
  const [exporting, setExporting] = useState(null);

  const [exportError, setExportError] = useState(false);

  const [searchedAt, setSearchedAt] = useState(() => new Date());

  // Apollo can hand over another search's results without remounting this, so the time follows
  // the results rather than the mount.
  useEffect(() => {
    setSearchedAt(new Date());
  }, [results]);

  const filename = (extension) => {
    const today = new Date().toISOString().slice(0, 10);

    return `semantic-search-${slugify(query)}-${today}.${extension}`;
  };

  const exportExcel = async () => {
    setExporting('excel');
    setExportError(false);

    try {
      const { default: writeExcelFile, getSheetData } = await import('write-excel-file/browser');

      const columns = buildColumns(window.location.origin);

      // A file with several sheets takes rows rather than objects, so the results are converted
      // first. The columns still set the widths.
      await writeExcelFile([
        { sheet: 'Results', data: getSheetData(results, columns), columns },
        {
          sheet: 'Search',
          data: buildSearchSheet({ query, interpretation, searchedAt }),
          columns: searchColumns,
        },
      ]).toFile(filename('xlsx'));
    } catch {
      setExportError(true);
    } finally {
      setExporting(null);
    }
  };

  const exportCsv = () => {
    setExporting('csv');
    setExportError(false);

    try {
      const blob = new Blob([buildCsv(results, window.location.origin)], {
        type: 'text/csv;charset=utf-8',
      });

      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');

      link.href = url;
      link.download = filename('csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          color="gray"
          size="sm"
          onClick={exportCsv}
          disabled={Boolean(exporting) || results.length === 0}
          data-cy="semantic-search-export-csv"
        >
          <FontAwesomeIcon icon={faFileCsv} className="mr-2" />
          <Trans>Export to CSV</Trans>
        </Button>
        <Button
          color="gray"
          size="sm"
          onClick={exportExcel}
          disabled={Boolean(exporting) || results.length === 0}
          data-cy="semantic-search-export"
        >
          <FontAwesomeIcon icon={faFileExcel} className="mr-2" />
          <Trans>Export to Excel</Trans>
        </Button>
      </div>
      {exportError && (
        <span className="text-sm text-red-700" role="alert" data-cy="semantic-search-export-error">
          <Trans>Could not export these results. Please try again.</Trans>
        </span>
      )}
    </div>
  );
}
