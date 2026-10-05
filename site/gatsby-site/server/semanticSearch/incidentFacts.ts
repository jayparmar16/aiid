/**
 * The facts semantic search filters on, loaded from MongoDB in one pass and held in memory: entity
 * names, the links editors made between entities, which incidents each entity occurs in, by role,
 * and each incident's MIT risk domain. It is the parser's vocabulary and the source of every
 * constraint's incident set.
 */

import { MongoClient } from 'mongodb';
import {
  EntityRole,
  HARMED_ROLES,
  RESPONSIBLE_ROLES,
  ResolvedEntity,
  toWords,
  Vocabulary,
} from './parseQuery';

const ROLE_FIELDS: Record<EntityRole, string> = {
  deployer: 'Alleged deployer of AI system',
  developer: 'Alleged developer of AI system',
  implicated: 'implicated_systems',
  harmed: 'Alleged harmed or nearly harmed parties',
};

const ROLES = Object.keys(ROLE_FIELDS) as EntityRole[];

export interface IncidentFacts extends Vocabulary {
  incidentIds: ReadonlySet<number>;
  /** Incidents in which any of the entities occurs in any of the roles. */
  incidentsWith: (entityIds: readonly string[], roles: readonly EntityRole[]) => Set<number>;
  /** The entity's name, or undefined when no entity with a usable name has that id. */
  nameOf: (entityId: string) => string | undefined;
  /** Every named entity that occurs in a responsible role, ordered by name. */
  responsibleEntities: readonly { entityId: string; name: string }[];
  /** Every named entity that is an alleged harmed or nearly harmed party, ordered by name. */
  harmedEntities: readonly { entityId: string; name: string }[];
  /** The incident's date as `YYYY-MM-DD`, or an empty string when it has none. */
  dateOf: (incidentId: number) => string;
  /**
   * Incidents dated within inclusive `YYYY-MM-DD` bounds, either of which may be null for an open
   * end. An incident without a usable date is never in a date range.
   */
  incidentsDated: (dateFrom: string | null, dateTo: string | null) => Set<number>;
  /** The earliest and latest incident dates, or null when no incident has a usable date. */
  dateSpan: { earliest: string; latest: string } | null;
  /** Incidents whose published MIT classification has any of the risk domains. */
  incidentsInMitDomains: (domains: readonly string[]) => Set<number>;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const MIT_NAMESPACE = 'MIT';
const MIT_RISK_DOMAIN = 'Risk Domain';

/** The attribute's value, which classifications store as a JSON-encoded string. */
const parseValue = (valueJson: unknown): unknown => {
  if (typeof valueJson !== 'string') return undefined;

  try {
    return JSON.parse(valueJson);
  } catch {
    return undefined;
  }
};

const containsSequence = (words: readonly string[], sequence: readonly string[]) => {
  for (let start = 0; start + sequence.length <= words.length; start++) {
    if (sequence.every((word, offset) => words[start + offset] === word)) return true;
  }

  return false;
};

const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
  const values = map.get(key);

  if (values) values.add(value);
  else map.set(key, new Set([value]));
};

const MATCH_ORDER: ResolvedEntity['matchedBy'][] = ['NAME', 'FAMILY', 'LINK'];

export const loadIncidentFacts = async (client: MongoClient): Promise<IncidentFacts> => {
  const db = client.db('aiidprod');
  const roleProjection = Object.fromEntries(Object.values(ROLE_FIELDS).map((field) => [field, 1]));

  const [entities, incidents, links, mitTaxa, mitClassifications] = await Promise.all([
    db
      .collection('entities')
      .find({}, { projection: { _id: 0, entity_id: 1, name: 1 } })
      .toArray(),
    db
      .collection('incidents')
      .find({}, { projection: { _id: 0, incident_id: 1, date: 1, ...roleProjection } })
      .toArray(),
    db
      .collection('entity_relationships')
      .find({}, { projection: { _id: 0, sub: 1, obj: 1, is_symmetric: 1 } })
      .toArray(),
    db
      .collection('taxa')
      .find({ namespace: MIT_NAMESPACE }, { projection: { _id: 0, field_list: 1 } })
      .toArray(),
    // Only published classifications count, as everywhere else on the site.
    db
      .collection('classifications')
      .find(
        { namespace: MIT_NAMESPACE, publish: true },
        {
          projection: {
            _id: 0,
            incidents: 1,
            attributes: { $elemMatch: { short_name: MIT_RISK_DOMAIN } },
          },
        }
      )
      .toArray(),
  ]);

  const incidentIds = new Set<number>();
  const dates = new Map<number, string>();
  const incidentsByRole = new Map<EntityRole, Map<string, Set<number>>>(
    ROLES.map((role) => [role, new Map()])
  );

  for (const incident of incidents) {
    incidentIds.add(incident.incident_id);
    if (typeof incident.date === 'string') dates.set(incident.incident_id, incident.date);

    for (const role of ROLES) {
      const entityIds = incident[ROLE_FIELDS[role]];

      if (!Array.isArray(entityIds)) continue;

      for (const entityId of entityIds) {
        addTo(incidentsByRole.get(role)!, entityId, incident.incident_id);
      }
    }
  }

  const occursIn = (entityId: string, roles: readonly EntityRole[]) =>
    roles.some((role) => incidentsByRole.get(role)!.has(entityId));

  const names = new Map<string, string>();
  const idsByName = new Map<string, Set<string>>();
  const wordsById = new Map<string, string[]>();
  const idsByWord = new Map<string, Set<string>>();
  let longestNameWords = 0;

  for (const { entity_id: entityId, name } of entities) {
    if (typeof entityId !== 'string' || typeof name !== 'string') continue;

    const words = toWords(name);

    if (words.length === 0) continue;

    names.set(entityId, name);
    addTo(idsByName, words.join(' '), entityId);
    longestNameWords = Math.max(longestNameWords, words.length);

    // Only entities that occur somewhere can join a family, so only they are indexed by word.
    if (occursIn(entityId, ROLES)) {
      wordsById.set(entityId, words);
      for (const word of new Set(words)) addTo(idsByWord, word, entityId);
    }
  }

  // The entity editor saves each link once, from the entity being edited, and marks it symmetric,
  // so a link is followed both ways. One explicitly marked as not symmetric runs from sub to obj.
  const linkedIds = new Map<string, Set<string>>();

  for (const { sub, obj, is_symmetric: isSymmetric } of links) {
    if (typeof sub !== 'string' || typeof obj !== 'string' || sub === obj) continue;

    addTo(linkedIds, sub, obj);
    if (isSymmetric !== false) addTo(linkedIds, obj, sub);
  }

  const resolve: Vocabulary['resolve'] = (words, roles, { allowNameStart = false } = {}) => {
    const named = idsByName.get(words.join(' ')) ?? new Set<string>();
    const candidates = Array.from(idsByWord.get(words[0]) ?? []).filter((id) =>
      occursIn(id, roles)
    );

    // The first words of a name stand for it only when every name they start continues the same
    // way, as "clearview" does for "Clearview AI ...". Words that start unrelated names, like
    // "deepfake" ("Deepfake creators", "Deepfake technology") or "ai", are a topic, not a name.
    const startsAName = () => {
      const started = candidates
        .map((id) => wordsById.get(id)!)
        .filter((name) => words.every((word, index) => name[index] === word));

      if (started.length === 0) return false;

      const stem = started.reduce((shortest, name) =>
        name.length < shortest.length ? name : shortest
      );

      return started.every((name) => stem.every((word, index) => name[index] === word));
    };

    if (named.size === 0 && !(allowNameStart && startsAName())) return [];

    // The family is every entity whose name contains the written words, which takes in the named
    // entity itself and products named after it ("Tesla Autopilot" for "tesla").
    const family = candidates
      .filter((id) => containsSequence(wordsById.get(id)!, words))
      .map(
        (id): ResolvedEntity => ({
          entityId: id,
          name: names.get(id)!,
          matchedBy: named.has(id) ? 'NAME' : 'FAMILY',
        })
      );

    // Links let editors join entities whose names share nothing, such as Meta and Facebook. They
    // are followed one step from the named entity only: the rest of the family is already a step
    // away, and its links drift further ("Unknown scammers operating Meta ad accounts" is linked to
    // Scammers, which would make excluding Meta remove every scam).
    const covered = new Set(family.map((entity) => entity.entityId));
    const linked: ResolvedEntity[] = [];

    for (const { entityId } of family.filter((member) => member.matchedBy === 'NAME')) {
      for (const id of linkedIds.get(entityId) ?? []) {
        if (covered.has(id) || !names.has(id) || !occursIn(id, roles)) continue;

        covered.add(id);
        linked.push({ entityId: id, name: names.get(id)!, matchedBy: 'LINK' });
      }
    }

    return [...family, ...linked].sort(
      (left, right) =>
        MATCH_ORDER.indexOf(left.matchedBy) - MATCH_ORDER.indexOf(right.matchedBy) ||
        left.name.localeCompare(right.name)
    );
  };

  const incidentsWith = (entityIds: readonly string[], roles: readonly EntityRole[]) => {
    const found = new Set<number>();

    for (const role of roles) {
      for (const entityId of entityIds) {
        for (const incidentId of incidentsByRole.get(role)!.get(entityId) ?? []) {
          found.add(incidentId);
        }
      }
    }

    return found;
  };

  const nameOf = (entityId: string) => names.get(entityId);

  const entitiesIn = (roles: readonly EntityRole[]) =>
    Array.from(wordsById.keys())
      .filter((entityId) => occursIn(entityId, roles))
      .map((entityId) => ({ entityId, name: names.get(entityId)! }))
      .sort((left, right) => left.name.localeCompare(right.name));

  const dateOf = (incidentId: number) => dates.get(incidentId) ?? '';

  // Dates in this form compare correctly as text, so ranges need no parsing.
  const usableDates = Array.from(dates).filter(([, date]) => ISO_DAY.test(date));

  const incidentsDated = (dateFrom: string | null, dateTo: string | null) =>
    new Set(
      usableDates
        .filter(([, date]) => (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo))
        .map(([incidentId]) => incidentId)
    );

  const sortedDates = usableDates.map(([, date]) => date).sort();

  const dateSpan =
    sortedDates.length > 0
      ? { earliest: sortedDates[0], latest: sortedDates[sortedDates.length - 1] }
      : null;

  const incidentsByMitDomain = new Map<string, Set<number>>();

  for (const classification of mitClassifications) {
    const domain = parseValue(classification.attributes?.[0]?.value_json);

    if (typeof domain !== 'string' || !Array.isArray(classification.incidents)) continue;

    for (const incidentId of classification.incidents) {
      addTo(incidentsByMitDomain, domain, incidentId);
    }
  }

  // The taxonomy lists the domains in their numbered order. Should it be missing, the domains that
  // classifications use are still offered.
  const permittedDomains = mitTaxa
    .flatMap((taxa) => (Array.isArray(taxa.field_list) ? taxa.field_list : []))
    .find((field) => field?.short_name === MIT_RISK_DOMAIN)?.permitted_values;

  const mitRiskDomains: string[] = Array.isArray(permittedDomains)
    ? permittedDomains.filter((domain): domain is string => typeof domain === 'string')
    : Array.from(incidentsByMitDomain.keys()).sort();

  const incidentsInMitDomains = (domains: readonly string[]) =>
    new Set(domains.flatMap((domain) => Array.from(incidentsByMitDomain.get(domain) ?? [])));

  return {
    incidentsDated,
    dateSpan,
    incidentIds,
    incidentsWith,
    incidentCount: (entityIds: readonly string[], roles: readonly EntityRole[]) =>
      incidentsWith(entityIds, roles).size,
    nameOf,
    dateOf,
    resolve,
    longestNameWords,
    responsibleEntities: entitiesIn(RESPONSIBLE_ROLES),
    harmedEntities: entitiesIn(HARMED_ROLES),
    mitRiskDomains,
    incidentsInMitDomains,
  };
};
