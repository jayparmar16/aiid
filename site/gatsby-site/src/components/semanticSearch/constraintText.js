// Spells out "1 entity" or "6 entities", since these strings have no plural translations.
export const counted = (t, count, one, many) => (count === 1 ? t(one) : t(many, { count }));

// Marks entities covered through an editor's link rather than the written name, which would
// otherwise look out of place in the list (Facebook under "Excluding: Meta").
export const entityList = (t, entities) =>
  entities
    .map((entity) =>
      entity.matchedBy === 'LINK' ? t('{{name}} (linked)', { name: entity.name }) : entity.name
    )
    .join(', ');

/** The entity whose name was written, or the words themselves when no entity has that whole name. */
export const constraintName = (constraint) =>
  constraint.entities.find((entity) => entity.matchedBy === 'NAME')?.name ?? constraint.matchedText;
