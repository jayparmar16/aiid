import React, { useRef, useState } from 'react';
import { useLazyQuery } from '@apollo/client';
import { Trans, useTranslation } from 'react-i18next';
import { Button, Spinner, TextInput } from 'flowbite-react';
import HeadContent from '../../components/HeadContent';
import { ApiAccessGate } from '../../components/ui/ApiLoginRequired';
import SemanticSearchTable from '../../components/semanticSearch/SemanticSearchTable';
import ExcelExport from '../../components/semanticSearch/ExcelExport';
import SearchInterpretation from '../../components/semanticSearch/SearchInterpretation';
import OrganisationFilter from '../../components/semanticSearch/OrganisationFilter';
import AffectedPartyFilter from '../../components/semanticSearch/AffectedPartyFilter';
import DateRangeFilter from '../../components/semanticSearch/DateRangeFilter';
import SearchWordsPanel from '../../components/semanticSearch/SearchWordsPanel';
import { kindOf } from '../../components/semanticSearch/EntityFilter';
import { SEMANTIC_SEARCH } from '../../graphql/semanticSearch';

const exampleQueries = [
  'deepfake related incidents',
  'self-driving crashes excluding tesla',
  'lawsuits against openai since 2023',
];

// The words the search reads as filters, each with what it does. The words stay untranslated,
// since the search reads them in English.
const legend = [
  ['excluding', 'drops an organisation'],
  ['by', 'made or used by'],
  ['affecting', 'who was harmed'],
  ['against', 'harmed group or company'],
  ['since / before', 'limits the dates'],
];

const RESPONSIBLE_ROLES = ['DEPLOYER', 'DEVELOPER', 'IMPLICATED'];

const ENTITY_KINDS = ['EXCLUDE_ENTITY', 'INCLUDE_ENTITY', 'HARMED_PARTY'];

const sameRoles = (left, right) =>
  [...(left ?? [])].sort().join() === [...(right ?? [])].sort().join();

// A date range chip is held by its bounds, either of which may be null.
const isDateChip = ({ filter }) => 'dateFrom' in filter;

// The chips the organisation and affected party controls edit, which name entities.
const isEntityChip = (chip) => !isDateChip(chip);

/** An inclusion or affected party as the search takes it: by id or by name, with its roles. */
const includeFilter = ({ filter, constraint }) => {
  const roles = kindOf({ filter, constraint }) === 'HARMED_PARTY' ? ['HARMED'] : filter.roles;

  return {
    ...(filter.id ? { entityId: filter.id } : { name: filter.name }),
    ...(roles && { roles }),
  };
};

/**
 * Sends each chip's filter back with the next search. A typed constraint is held by the words that
 * named it, which the search reads again exactly as typed, so it keeps every entity it covered.
 * Inclusions and a date range are sent only when held, so other searches ask
 * exactly what they did.
 */
const filtersFor = (chips) => {
  const dateChip = chips.find(isDateChip);

  const entityChips = chips.filter(isEntityChip);

  const ofKind = (kind) => entityChips.filter((chip) => kindOf(chip) === kind);

  const exclusions = ofKind('EXCLUDE_ENTITY').map(({ filter }) => filter);

  const include = [...ofKind('INCLUDE_ENTITY'), ...ofKind('HARMED_PARTY')].map(includeFilter);

  return {
    excludeEntities: exclusions.flatMap((filter) => (filter.id ? [filter.id] : [])),
    excludeNames: exclusions.flatMap((filter) => (filter.name ? [filter.name] : [])),
    ...(include.length > 0 && { include }),
    ...(dateChip && { dateFrom: dateChip.filter.dateFrom, dateTo: dateChip.filter.dateTo }),
  };
};

// Whether a constraint is the one a held chip's filter asked for. An explicit constraint echoes the
// name or id it was sent as its matched text.
const isHeldBy = (chip, constraint) => {
  return (
    kindOf({ filter: chip.filter }) === constraint.kind &&
    constraint.matchedText === (chip.filter.name ?? chip.filter.id) &&
    (constraint.kind !== 'INCLUDE_ENTITY' ||
      sameRoles(chip.filter.roles ?? RESPONSIBLE_ROLES, constraint.roles))
  );
};

/**
 * Pairs each constraint a search applied with the filter that brings it back. An explicit one
 * echoes the name or id it was sent as its matched text, so held chips keep their filter
 * and their place, and a held filter that matches nothing any more is dropped. Newly typed ones
 * follow, held by their matched text.
 */
const chipsFrom = (constraints, held) => {
  const explicit = constraints.filter(
    (constraint) => constraint.source === 'EXPLICIT_FILTER' && constraint.kind !== 'DATE_RANGE'
  );

  const kept = held
    .filter((chip) => !isDateChip(chip))
    .flatMap((chip) => {
      const index = explicit.findIndex((constraint) => isHeldBy(chip, constraint));

      return index < 0 ? [] : [{ filter: chip.filter, constraint: explicit.splice(index, 1)[0] }];
    });

  // A typed inclusion keeps the roles its linking word gave it, such as "developed by".
  const typed = constraints
    .filter(
      (constraint) => constraint.source === 'QUERY_TEXT' && ENTITY_KINDS.includes(constraint.kind)
    )
    .map((constraint) => ({
      filter: {
        kind: constraint.kind,
        name: constraint.matchedText,
        ...(constraint.kind === 'INCLUDE_ENTITY' && { roles: constraint.roles }),
      },
      constraint,
    }));

  // A search has at most one date range, since a typed one replaces the one held, and its bounds
  // bring it back exactly.
  const dates = constraints
    .filter((constraint) => constraint.kind === 'DATE_RANGE')
    .map((constraint) => ({
      filter: { dateFrom: constraint.dateFrom, dateTo: constraint.dateTo },
      constraint,
    }));

  return [...kept, ...typed, ...dates];
};

/**
 * Searches incidents by meaning using stored incident embeddings. Forms and example buttons share
 * the same execution path, and Apollo's cache answers a repeated query without another request.
 */
export default function SemanticSearchPage() {
  const { t } = useTranslation();

  const [input, setInput] = useState('');

  const inputRef = useRef(null);

  const [submitted, setSubmitted] = useState('');

  // The constraints of the latest search, shown as removable chips and sent with the next one.
  const [chips, setChips] = useState([]);

  const [search, { data, loading, error }] = useLazyQuery(SEMANTIC_SEARCH);

  const response = data?.semanticSearch;

  const results = response?.status === 'OK' ? response.results : [];

  /**
   * Searches the text together with the held chips. Once the text has been read, the box keeps
   * only what is left to rank by meaning and the chips hold the constraints, so the next search
   * parses only newly typed text and never applies a constraint twice.
   */
  const runSearch = async (text, held) => {
    const query = text.trim();

    setInput(query);
    setSubmitted(query);
    setChips(held);

    const { data: next, error: failed } = await search({
      variables: { query, filters: filtersFor(held) },
    });

    const interpretation = next?.semanticSearch.interpretation;

    if (failed || !interpretation) return;

    setChips(chipsFrom(interpretation.constraints, held));

    // A query in which nothing was read stays exactly as typed.
    if (interpretation.constraints.length > 0 || interpretation.warnings.length > 0) {
      setInput(interpretation.semanticText);
    }
  };

  const canSearch = Boolean(input.trim()) || chips.length > 0;

  const onSubmit = (event) => {
    event.preventDefault();
    if (canSearch) runSearch(input, chips);
  };

  const removeConstraint = (removed) => {
    const remaining = chips.filter((chip) => chip.constraint !== removed);

    runSearch(input, remaining);
  };

  // Applying a suggestion adds the filter it offers, so the search keeps it from then on.
  const acceptSuggestion = (suggestion) => {
    if (suggestion.kind === 'INCLUDE_ENTITY') {
      runSearch(input, [
        ...chips,
        { filter: { kind: 'INCLUDE_ENTITY', id: suggestion.value }, label: suggestion.label },
      ]);
    }
  };

  // An example from the tips panel goes into the box to edit, and is searched only when sent.
  const fillWithExample = (example) => {
    setInput(example);
    inputRef.current?.focus();
  };

  // A chip picked from a control has no constraint until its search returns.
  const constraints = chips.flatMap((chip) => (chip.constraint ? [chip.constraint] : []));

  const dateChips = chips.filter(isDateChip);

  const entityChips = chips.filter(isEntityChip);

  // The entity controls hand back the entity chips they edit, so the others are put back with them.
  const changeEntities = (next) =>
    runSearch(input, [...next, ...chips.filter((chip) => !isEntityChip(chip))]);

  return (
    <div className="w-full">
      <h1 className="text-2xl font-semibold mb-2">
        <Trans>Semantic Search</Trans>
      </h1>
      <p className="mb-4 text-gray-600">
        <Trans>
          Describe what happened in your own words to list the incidents that match it most closely.
        </Trans>
      </p>

      {/* The search reads through the API, which requires a logged-in, unblocked account.
          SEE: server/apiAccess.ts */}
      <ApiAccessGate>
        <SearchWordsPanel onUseExample={fillWithExample} />

        <div className="flex flex-wrap items-center gap-2 mb-4" data-cy="semantic-search-examples">
          <span className="text-sm text-gray-600">
            <Trans>Try an example:</Trans>
          </span>
          {/* An example starts fresh, so filters held from an earlier search don't change it. */}
          {exampleQueries.map((query, index) => (
            <button
              key={query}
              type="button"
              disabled={loading}
              onClick={() => runSearch(query, [])}
              className="rounded-full border border-blue-300 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              data-cy={`semantic-search-example-${index + 1}`}
            >
              {t(query)}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="flex gap-2 mb-4" data-cy="semantic-search-form">
          <TextInput
            ref={inputRef}
            className="flex-1"
            value={input}
            maxLength={500}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('Describe an incident in your own words')}
            data-cy="semantic-search-input"
          />
          <Button type="submit" disabled={loading || !canSearch} data-cy="semantic-search-submit">
            <Trans>Search</Trans>
          </Button>
        </form>

        <p
          className="-mt-2 mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500"
          data-cy="semantic-search-legend"
        >
          {legend.map(([word, meaning]) => (
            <span key={word}>
              <span className="font-semibold text-gray-700">{word}</span> {t(meaning)}
            </span>
          ))}
        </p>

        <OrganisationFilter chips={entityChips} disabled={loading} onChange={changeEntities} />

        <AffectedPartyFilter chips={entityChips} disabled={loading} onChange={changeEntities} />

        <DateRangeFilter
          range={dateChips[0]?.filter}
          disabled={loading}
          onChange={(range) =>
            runSearch(input, [
              ...chips.filter((chip) => !isDateChip(chip)),
              ...(range ? [{ filter: range }] : []),
            ])
          }
        />

        {loading && <Spinner />}

        {/* Shown with every status, so a refused search still says how the query was read. */}
        {!loading && (
          <SearchInterpretation
            semanticText={response?.interpretation.semanticText}
            constraints={constraints}
            warnings={response?.interpretation.warnings}
            suggestions={response?.interpretation.suggestions}
            onRemove={removeConstraint}
            onAccept={acceptSuggestion}
          />
        )}

        {!loading && (error || response?.status === 'UNAVAILABLE') && (
          <p className="text-red-700" data-cy="semantic-search-unavailable">
            <Trans>Search is unavailable right now. Please try again later.</Trans>
          </p>
        )}

        {!loading && response?.status === 'QUOTA_EXHAUSTED' && (
          <p className="text-amber-700" data-cy="semantic-search-limited">
            <Trans>The search limit has been reached for now. Please try again later.</Trans>
          </p>
        )}

        {!loading && response?.status === 'OK' && results.length === 0 && (
          <p data-cy="semantic-search-empty">
            <Trans>No incidents closely match that description.</Trans>
          </p>
        )}

        {!loading && results.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-2">
              <span data-cy="semantic-search-count">
                {response.totalCount > results.length
                  ? t('Showing {{shown}} of {{total}}', {
                      shown: results.length,
                      total: response.totalCount,
                    })
                  : t('{{count}} matching incidents', { count: results.length })}
              </span>
              <ExcelExport
                results={results}
                query={submitted}
                interpretation={response.interpretation}
              />
            </div>
            <SemanticSearchTable results={results} />
          </>
        )}
      </ApiAccessGate>
    </div>
  );
}

export const Head = (props) => {
  const {
    location: { pathname },
  } = props;

  const { t } = useTranslation();

  return (
    <HeadContent
      path={pathname}
      metaTitle={t('Semantic Search')}
      metaDescription={t('Find incidents that match a description written in your own words.')}
    />
  );
};
