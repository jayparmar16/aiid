import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Tags from '../forms/Tags';

/**
 * The kind of constraint a chip stands for. A chip picked from a control has no constraint until
 * its search returns, so until then its filter says what it is.
 */
export const kindOf = ({ filter, constraint }) =>
  constraint?.kind ?? filter.kind ?? 'EXCLUDE_ENTITY';

// Named like its chip, so the same constraint reads the same in both places. A picked entity has
// no constraint until its search returns, so it keeps the name it was picked by until then.
const nameOf = ({ filter, constraint, label }) =>
  constraint?.entities.find((entity) => entity.matchedBy === 'NAME')?.name ??
  label ??
  constraint?.matchedText ??
  filter.name ??
  filter.id;

// An inclusion read from "developed by" or "deployed by" holds one role, which its token says.
const roleNotes = { DEVELOPER: '{{name}} (developer)', DEPLOYER: '{{name}} (deployer)' };

/**
 * Picks entities from `entities` for one kind of constraint. It shows the chips of that kind,
 * typed ones included, so picking, typing and removing all edit one set of filters, and it hands
 * back every chip after each change, keeping their order and adding new picks at the end.
 */
export default function EntityFilter({
  kind,
  entities,
  chips,
  onChange,
  disabled = false,
  inputId,
  label,
  placeholder,
  ...props
}) {
  const { t } = useTranslation();

  const own = chips.filter((chip) => kindOf(chip) === kind);

  const options = useMemo(() => {
    // An entity a chip of this kind already covers would change nothing, so it is not offered again.
    const covered = new Set(
      chips
        .filter((chip) => kindOf(chip) === kind)
        .flatMap(({ filter, constraint }) =>
          constraint ? constraint.entities.map((entity) => entity.entity_id) : [filter.id]
        )
    );

    return (entities ?? [])
      .filter((entity) => !covered.has(entity.entity_id))
      .map((entity) => ({ label: entity.name, entityId: entity.entity_id }));
  }, [entities, chips, kind]);

  const selected = own.map((chip) => {
    const roles = chip.constraint?.roles ?? chip.filter.roles;

    const note = roles?.length === 1 ? roleNotes[roles[0]] : undefined;

    const name = nameOf(chip);

    return { label: note ? t(note, { name }) : name, chip };
  });

  const change = (items) => {
    const kept = new Set(items.flatMap((item) => (item.chip ? [item.chip] : [])));

    const added = items.flatMap((item) => {
      if (item.chip) return [];

      if (item.entityId) return [{ filter: { kind, id: item.entityId }, label: item.label }];

      // Text entered without picking an option is read like a name typed in the query.
      const name = String(item).trim();

      return name ? [{ filter: { kind, name } }] : [];
    });

    onChange([...chips.filter((chip) => kindOf(chip) !== kind || kept.has(chip)), ...added]);
  };

  return (
    <div className="mb-4 flex-1 min-w-[16rem]" {...props}>
      <label htmlFor={inputId} className="block text-sm mb-1">
        {label}
      </label>
      <div className="tags-control-wrapper rounded-md form-control bootstrap">
        <Tags
          id={`${inputId}-tags`}
          inputId={inputId}
          placeHolder={placeholder}
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
