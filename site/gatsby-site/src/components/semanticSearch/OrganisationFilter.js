import React, { useMemo } from 'react';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import Tags from '../forms/Tags';
import { SEMANTIC_SEARCH_FACETS } from '../../graphql/semanticSearch';

// Named like its chip, so the same exclusion reads the same in both places. A picked entity has
// no constraint until its search returns, so it keeps the name it was picked by until then.
const labelOf = ({ filter, constraint, label }) =>
  constraint?.entities.find((entity) => entity.matchedBy === 'NAME')?.name ??
  label ??
  constraint?.matchedText ??
  filter.name ??
  filter.id;

/**
 * Picks organisations to exclude from those that occur as an alleged deployer, developer or
 * implicated system. It shows the same chips as the interpretation, typed ones included, so
 * picking, typing and removing all edit one set of exclusions, and it hands back the whole set
 * after every change.
 */
export default function OrganisationFilter({ chips, onChange, disabled = false }) {
  const { t } = useTranslation();

  // Loaded once per visit: Apollo's cache answers every later render without another request.
  const { data } = useQuery(SEMANTIC_SEARCH_FACETS);

  const entities = data?.semanticSearchFacets.responsibleEntities;

  const options = useMemo(() => {
    // An entity an exclusion already covers would change nothing, so it is not offered again.
    const covered = new Set(
      chips.flatMap(({ filter, constraint }) =>
        constraint ? constraint.entities.map((entity) => entity.entity_id) : [filter.id]
      )
    );

    return (entities ?? [])
      .filter((entity) => !covered.has(entity.entity_id))
      .map((entity) => ({ label: entity.name, entityId: entity.entity_id }));
  }, [entities, chips]);

  const selected = chips.map((chip) => ({ label: labelOf(chip), chip }));

  const change = (items) =>
    onChange(
      items.flatMap((item) => {
        if (item.chip) return [item.chip];

        if (item.entityId) return [{ filter: { id: item.entityId }, label: item.label }];

        // Text entered without picking an option is read like a name typed after "excluding".
        const name = String(item).trim();

        return name ? [{ filter: { name } }] : [];
      })
    );

  return (
    <div className="mb-4" data-cy="semantic-search-organisations">
      <label htmlFor="semantic-search-exclude-organisations" className="block text-sm mb-1">
        {t('Exclude organisations')}
      </label>
      <div className="tags-control-wrapper rounded-md form-control bootstrap">
        <Tags
          id="semantic-search-exclude-organisations-tags"
          inputId="semantic-search-exclude-organisations"
          placeHolder={t('Type an organisation or system to exclude')}
          value={selected}
          onChange={change}
          options={options}
          labelKey="label"
          allowNew={false}
          splitChar={null}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
