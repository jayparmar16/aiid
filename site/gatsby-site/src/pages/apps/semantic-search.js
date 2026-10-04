import React, { useState } from 'react';
import { useLazyQuery } from '@apollo/client';
import { Trans, useTranslation } from 'react-i18next';
import { Button, Spinner, TextInput } from 'flowbite-react';
import HeadContent from '../../components/HeadContent';
import { ApiAccessGate } from '../../components/ui/ApiLoginRequired';
import SemanticSearchTable from '../../components/semanticSearch/SemanticSearchTable';
import ExcelExport from '../../components/semanticSearch/ExcelExport';
import SearchInterpretation from '../../components/semanticSearch/SearchInterpretation';
import OrganisationFilter from '../../components/semanticSearch/OrganisationFilter';
import { SEMANTIC_SEARCH } from '../../graphql/semanticSearch';

const exampleQueries = [
  'deepfake related incidents',
  'facial recognition leading to a wrongful arrest',
  'autonomous vehicle crashes involving pedestrians',
];

/**
 * Sends each chip's filter back with the next search. A typed exclusion is held by the words that
 * named it, which the search reads again exactly as typed, so it keeps every entity it covered.
 */
const filtersFor = (chips) => ({
  excludeEntities: chips.flatMap(({ filter }) => (filter.id ? [filter.id] : [])),
  excludeNames: chips.flatMap(({ filter }) => (filter.name ? [filter.name] : [])),
});

/**
 * Pairs each exclusion a search applied with the filter that brings it back. An explicit one
 * echoes the name or id it was sent as its matched text, so held chips keep their filter and their
 * place, and a held filter that matches nothing any more is dropped. Newly typed ones follow, held
 * by their matched text.
 */
const chipsFrom = (constraints, held) => {
  const explicit = constraints.filter((constraint) => constraint.source === 'EXPLICIT_FILTER');

  const kept = held.flatMap(({ filter }) => {
    const index = explicit.findIndex(
      (constraint) => constraint.matchedText === (filter.name ?? filter.id)
    );

    return index < 0 ? [] : [{ filter, constraint: explicit.splice(index, 1)[0] }];
  });

  const typed = constraints
    .filter(
      (constraint) => constraint.source === 'QUERY_TEXT' && constraint.kind === 'EXCLUDE_ENTITY'
    )
    .map((constraint) => ({ filter: { name: constraint.matchedText }, constraint }));

  return [...kept, ...typed];
};

/**
 * Searches incidents by meaning using stored incident embeddings. Forms and example buttons share
 * the same execution path, and Apollo's cache answers a repeated query without another request.
 */
export default function SemanticSearchPage() {
  const { t } = useTranslation();

  const [input, setInput] = useState('');

  const [submitted, setSubmitted] = useState('');

  // The exclusions of the latest search, shown as removable chips and sent with the next one.
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

  // A chip picked from the organisation control has no constraint until its search returns.
  const constraints = chips.flatMap((chip) => (chip.constraint ? [chip.constraint] : []));

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
        <div className="flex flex-wrap items-center gap-2 mb-4" data-cy="semantic-search-examples">
          <span className="text-sm text-gray-600">
            <Trans>Try an example:</Trans>
          </span>
          {exampleQueries.map((query, index) => (
            <button
              key={query}
              type="button"
              disabled={loading}
              onClick={() => runSearch(query, chips)}
              className="rounded-full border border-blue-300 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              data-cy={`semantic-search-example-${index + 1}`}
            >
              {t(query)}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="flex gap-2 mb-4" data-cy="semantic-search-form">
          <TextInput
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

        <OrganisationFilter
          chips={chips}
          disabled={loading}
          onChange={(next) => runSearch(input, next)}
        />

        {loading && <Spinner />}

        {/* Shown with every status, so a refused search still says how the query was read. */}
        {!loading && (
          <SearchInterpretation
            semanticText={response?.interpretation.semanticText}
            constraints={constraints}
            warnings={response?.interpretation.warnings}
            onRemove={removeConstraint}
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
                {t('{{count}} matching incidents', { count: results.length })}
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
