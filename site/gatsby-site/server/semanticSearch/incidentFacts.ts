/**
 * The facts semantic search filters on, loaded from MongoDB in one pass and held in memory: entity
 * names, the links editors made between entities, and which incidents each entity occurs in, by
 * role. It is the parser's vocabulary and the source of every constraint's incident set.
 */

import { MongoClient } from 'mongodb';
import { EntityRole, RESPONSIBLE_ROLES, ResolvedEntity, toWords, Vocabulary } from './parseQuery';

const ROLE_FIELDS: Record<EntityRole, string> = {
  deployer: 'Alleged deployer of AI system',
  developer: 'Alleged developer of AI system',
  implicated: 'implicated_systems',
};

export interface IncidentFacts extends Vocabulary {
  incidentIds: ReadonlySet<number>;
  /** Incidents in which any of the entities occurs in any of the roles. */
  incidentsWith: (entityIds: readonly string[], roles: readonly EntityRole[]) => Set<number>;
}

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

  const [entities, incidents, links] = await Promise.all([
    db
      .collection('entities')
      .find({}, { projection: { _id: 0, entity_id: 1, name: 1 } })
      .toArray(),
    db
      .collection('incidents')
      .find({}, { projection: { _id: 0, incident_id: 1, ...roleProjection } })
      .toArray(),
    db
      .collection('entity_relationships')
      .find({}, { projection: { _id: 0, sub: 1, obj: 1, is_symmetric: 1 } })
      .toArray(),
  ]);

  const incidentIds = new Set<number>();
  const incidentsByRole = new Map<EntityRole, Map<string, Set<number>>>(
    RESPONSIBLE_ROLES.map((role) => [role, new Map()])
  );

  for (const incident of incidents) {
    incidentIds.add(incident.incident_id);

    for (const role of RESPONSIBLE_ROLES) {
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
    if (occursIn(entityId, RESPONSIBLE_ROLES)) {
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

    const startsAName = () =>
      candidates.some((id) => words.every((word, index) => wordsById.get(id)![index] === word));

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

  return { incidentIds, incidentsWith, resolve, longestNameWords };
};
