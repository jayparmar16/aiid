/**
 * Reads constraints out of a plain-English semantic search query.
 *
 * Pure: the caller supplies the vocabulary of entity names, so this module never touches the
 * network or the database. Every rule about English wording (linking words, lists, plural
 * folding) lives here and nowhere else.
 */

export type EntityRole = 'deployer' | 'developer' | 'implicated' | 'harmed';

/** The roles in which an organisation or system is responsible for an incident. */
export const RESPONSIBLE_ROLES: readonly EntityRole[] = ['deployer', 'developer', 'implicated'];

/** The role of the parties an incident harmed or nearly harmed. */
export const HARMED_ROLES: readonly EntityRole[] = ['harmed'];

export interface ResolvedEntity {
  entityId: string;
  name: string;
  /**
   * NAME when the entity's whole name was written, FAMILY when its name contains what was written,
   * LINK when editors linked it to the NAME entity.
   */
  matchedBy: 'NAME' | 'FAMILY' | 'LINK';
}

export interface Vocabulary {
  /**
   * The entities occurring in `roles` that a name written as `words` covers, or an empty list when
   * the words are not a known name or none of the covered entities occurs in those roles. A known
   * name is an entity's whole name or, with `allowNameStart`, the first words of one ("clearview"
   * for "Clearview AI"). The covered entities are the name's family and the entities linked to the
   * named entity, ordered NAME, FAMILY, LINK.
   */
  resolve: (
    words: string[],
    roles: readonly EntityRole[],
    options?: { allowNameStart?: boolean }
  ) => ResolvedEntity[];
  /** The most words in any entity name, which bounds the longest-match search. */
  longestNameWords: number;
}

/**
 * EXCLUDE_ENTITY removes the incidents its entities occur in. INCLUDE_ENTITY and HARMED_PARTY keep
 * only those incidents, the first through responsible roles and the second through the harmed role.
 */
export interface EntityConstraint {
  kind: 'EXCLUDE_ENTITY' | 'INCLUDE_ENTITY' | 'HARMED_PARTY';
  source: 'QUERY_TEXT' | 'EXPLICIT_FILTER';
  /** The words written in the query or, for an explicit filter, the name or entity id as given. */
  matchedText: string;
  roles: readonly EntityRole[];
  entities: ResolvedEntity[];
}

export type Constraint = EntityConstraint;

export interface InterpretationWarning {
  code: 'UNRECOGNISED_EXCLUSION' | 'UNRECOGNISED_INCLUSION' | 'UNKNOWN_ENTITY';
  text: string;
}

/** A constraint offered for the user to accept, rather than applied. */
export interface Suggestion {
  /** INCLUDE_ENTITY offers to keep only the incidents the entity with id `value` is responsible for. */
  kind: 'INCLUDE_ENTITY';
  value: string;
  label: string;
}

export interface Interpretation {
  /**
   * What is left to rank by meaning. Equal to the query when no constraint was read, and empty
   * when only filler words are left.
   */
  semanticText: string;
  constraints: Constraint[];
  warnings: InterpretationWarning[];
  /** Plain mentions of responsible entities, in the order written, each offered as an inclusion. */
  suggestions: Suggestion[];
}

interface Token {
  word: string;
  start: number;
  end: number;
}

interface NameMatch {
  /** Token range of the written name, end exclusive. */
  start: number;
  end: number;
  entities: ResolvedEntity[];
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;

const normaliseWord = (word: string) => word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Splits text into lowercase words without accents or punctuation, the form names are matched in. */
export const toWords = (text: string): string[] =>
  Array.from(text.matchAll(WORD), (match) => normaliseWord(match[0])).filter(Boolean);

const tokenize = (text: string): Token[] =>
  Array.from(text.matchAll(WORD), (match) => ({
    word: normaliseWord(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  })).filter((token) => token.word);

/**
 * Strong exclusion phrases say "leave this out" unambiguously, so they act even when what follows
 * isn't a known name. Weak ones are everyday English ("cars without drivers", "does not work"), so
 * they act only on a known name that ends at a natural break. Longer phrases are listed first so
 * that "not involving" wins over "not".
 */
const STRONG_EXCLUSIONS = [
  'except for',
  'but not',
  'other than',
  'apart from',
  'aside from',
  'not involving',
  'not including',
  'not by',
  'not from',
  'excluding',
  'exclude',
  'except',
];

const WEAK_EXCLUSIONS = ['not', 'without'];

const EXCLUSION_PHRASES = [
  ...STRONG_EXCLUSIONS.map((phrase) => ({ words: phrase.split(' '), strong: true })),
  ...WEAK_EXCLUSIONS.map((phrase) => ({ words: phrase.split(' '), strong: false })),
];

interface InclusionPhrase {
  words: string[];
  kind: 'INCLUDE_ENTITY' | 'HARMED_PARTY';
  roles: readonly EntityRole[];
}

const inclusions = (
  phrases: string[],
  kind: InclusionPhrase['kind'],
  roles: readonly EntityRole[]
): InclusionPhrase[] => phrases.map((phrase) => ({ words: phrase.split(' '), kind, roles }));

/**
 * Linking words that keep only the incidents involving what follows them. The role-specific
 * phrases come before the bare "by" they end with, so "developed by" restricts the match to
 * developers.
 */
const INCLUSION_PHRASES = [
  ...inclusions(['developed by', 'made by', 'built by'], 'INCLUDE_ENTITY', ['developer']),
  ...inclusions(['deployed by', 'used by', 'operated by'], 'INCLUDE_ENTITY', ['deployer']),
  ...inclusions(['by', 'from', 'involving', 'involves'], 'INCLUDE_ENTITY', RESPONSIBLE_ROLES),
  ...inclusions(['affecting', 'harming', 'targeting', 'against'], 'HARMED_PARTY', HARMED_ROLES),
];

const YEAR = /^\d{4}$/;

const ARTICLES = new Set(['the', 'a', 'an', 'any', 'all']);
const LIST_JOINERS = new Set(['and', 'or']);
const BREAK = /[,.;:!?()[\]{}"“”]/;
const NAME_BREAK = /[,;]/;

/** The word as written and, for a plural, the singular forms to try after it. */
const withSingulars = (word: string): string[] => {
  const forms = [word];
  if (word.length > 4 && word.endsWith('es')) forms.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith('s')) forms.push(word.slice(0, -1));
  return forms;
};

/** The entities the words name, trying singular forms of the last word after the word as written. */
const readName = (
  words: string[],
  vocabulary: Vocabulary,
  allowNameStart: boolean,
  roles: readonly EntityRole[] = RESPONSIBLE_ROLES
) => {
  for (const last of withSingulars(words[words.length - 1])) {
    const entities = vocabulary.resolve([...words.slice(0, -1), last], roles, { allowNameStart });
    if (entities.length > 0) return entities;
  }

  return [];
};

/**
 * The entities a name covers when it is written after a strong exclusion phrase such as
 * "excluding", or an empty list when the whole text is not one known name. A name read from one
 * query is read again by this to apply it to the next, so it covers the same entities, even when
 * it is only the first words of several names ("gpt").
 */
export const readExcludedName = (name: string, vocabulary: Vocabulary): ResolvedEntity[] => {
  const words = toWords(name);

  return words.length > 0 ? readName(words, vocabulary, true) : [];
};

/**
 * The entities occurring in `roles` that a name covers when it is written after a linking word such
 * as "by" or "affecting", or an empty list when the whole text is not one known name. Unlike after
 * "excluding", the first words of a name are not enough: a linking word is everyday English, and
 * "affecting black" would otherwise keep every incident affecting Black students, drivers and so on.
 */
export const readIncludedName = (
  name: string,
  roles: readonly EntityRole[],
  vocabulary: Vocabulary
): ResolvedEntity[] => {
  const words = toWords(name);

  return words.length > 0 ? readName(words, vocabulary, false, roles) : [];
};

/**
 * Words that say what is being searched for without describing it, like the "incidents" in
 * "incidents excluding tesla". "involving AI" is one phrase, since every incident involves AI.
 */
const FILLER = ['incidents', 'incident', 'cases', 'related', 'involving ai'].map((phrase) =>
  phrase.split(' ')
);

const isOnlyFiller = (text: string) => {
  const words = toWords(text);
  let index = 0;

  while (index < words.length) {
    const filler = FILLER.find((phrase) =>
      phrase.every((word, offset) => words[index + offset] === word)
    );

    if (filler) index += filler.length;
    else if (ARTICLES.has(words[index])) index++;
    else return false;
  }

  return true;
};

/**
 * What is left to rank by meaning once constraints have been taken out of a query: nothing when
 * only filler words remain, so a search made only of constraints lists its matches instead of
 * ranking them against a word like "incidents". Anything meaningful is kept exactly as written,
 * filler included.
 */
export const meaningLeftIn = (text: string) => (isOnlyFiller(text) ? '' : text);

/** Collapses the gaps and stray separators left where constraint phrases were cut out. */
const tidy = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*(?=[,.;:!?])/g, '')
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '');

export const parseQuery = (query: string, vocabulary: Vocabulary): Interpretation => {
  const tokens = tokenize(query);
  const constraints: Constraint[] = [];
  const warnings: InterpretationWarning[] = [];
  const removed: [number, number][] = [];

  // Where a name after a linking word starts. A name there was either read as a constraint or
  // deliberately left alone, so it is never offered as a suggestion either.
  const afterLinkingWord = new Set<number>();

  const gapBefore = (index: number) =>
    index > 0 && index < tokens.length
      ? query.slice(tokens[index - 1].end, tokens[index].start)
      : '';

  const phraseAt = (index: number) =>
    EXCLUSION_PHRASES.find(({ words }) =>
      words.every(
        (word, offset) =>
          tokens[index + offset]?.word === word &&
          (offset === 0 || !BREAK.test(gapBefore(index + offset)))
      )
    );

  /** The inclusion phrase starting at `index`, except "from" before a year, which is a date. */
  const inclusionAt = (index: number) => {
    const inclusion = INCLUSION_PHRASES.find(({ words }) =>
      words.every(
        (word, offset) =>
          tokens[index + offset]?.word === word &&
          (offset === 0 || !BREAK.test(gapBefore(index + offset)))
      )
    );

    if (inclusion?.words[0] === 'from' && YEAR.test(tokens[index + 1]?.word ?? ''))
      return undefined;

    return inclusion;
  };

  const skipArticles = (index: number) => {
    while (index < tokens.length && ARTICLES.has(tokens[index].word)) index++;
    return index;
  };

  /**
   * The longest known name starting at `start`, trying singular forms of its last word. Only a
   * strong phrase accepts the start of a name, because the everyday words that weak phrases and
   * prefixes catch ("not work", "non-consensual") often begin some entity's name.
   */
  const nameAt = (
    start: number,
    allowNameStart = false,
    roles: readonly EntityRole[] = RESPONSIBLE_ROLES
  ): NameMatch | null => {
    const longest = Math.min(vocabulary.longestNameWords, tokens.length - start);

    for (let count = longest; count > 0; count--) {
      const end = start + count;
      const crossesBreak = tokens
        .slice(start + 1, end)
        .some((_, offset) => NAME_BREAK.test(gapBefore(start + 1 + offset)));
      if (crossesBreak) continue;

      const words = tokens.slice(start, end).map((token) => token.word);
      const entities = readName(words, vocabulary, allowNameStart, roles);

      if (entities.length > 0) return { start, end, entities };
    }

    return null;
  };

  /** Reads "tesla", "tesla and uber" or "tesla, waymo, or uber", stopping at an unknown name. */
  const namesAt = (
    start: number,
    allowNameStart: boolean,
    roles: readonly EntityRole[] = RESPONSIBLE_ROLES
  ): NameMatch[] => {
    const names: NameMatch[] = [];
    let at = skipArticles(start);

    while (at < tokens.length) {
      const name = nameAt(at, allowNameStart, roles);
      if (!name) break;
      names.push(name);

      let next = name.end;
      if (next >= tokens.length) break;

      const gap = gapBefore(next);
      if (LIST_JOINERS.has(tokens[next].word) && /^[\s,]*$/.test(gap)) next++;
      else if (gap.trim() !== ',') break;

      at = skipArticles(next);
    }

    return names;
  };

  /** Whether a token range ending at `end` is followed by the end, punctuation or a linking word. */
  const endsAtBreak = (end: number) =>
    end >= tokens.length ||
    BREAK.test(gapBefore(end)) ||
    Boolean(phraseAt(end)) ||
    Boolean(inclusionAt(end));

  /** The first token after `start` that begins a new clause, or the end of the query. */
  const clauseEnd = (start: number) => {
    let index = start + 1;
    while (index < tokens.length && !endsAtBreak(index)) index++;
    return Math.min(index, tokens.length);
  };

  const exclude = (name: NameMatch) =>
    constraints.push({
      kind: 'EXCLUDE_ENTITY',
      source: 'QUERY_TEXT',
      matchedText: query.slice(tokens[name.start].start, tokens[name.end - 1].end),
      roles: RESPONSIBLE_ROLES,
      entities: name.entities,
    });

  /**
   * Reads the names after an inclusion phrase as constraints and returns where reading continues.
   * Each name must be an entity's whole name and occur in the phrase's roles. Anything else is left
   * in the text exactly as written, linking word included, so nothing typed is lost.
   */
  const include = (index: number, inclusion: InclusionPhrase) => {
    const afterPhrase = index + inclusion.words.length;
    const names = namesAt(afterPhrase, false, inclusion.roles);

    afterLinkingWord.add(skipArticles(afterPhrase));

    if (names.length === 0) return afterPhrase;

    for (const name of names) {
      constraints.push({
        kind: inclusion.kind,
        source: 'QUERY_TEXT',
        matchedText: query.slice(tokens[name.start].start, tokens[name.end - 1].end),
        roles: inclusion.roles,
        entities: name.entities,
      });
    }

    const end = names[names.length - 1].end;

    removed.push([tokens[index].start, tokens[end - 1].end]);

    return end;
  };

  /**
   * Offers each plain mention of an entity that is responsible for some incident as an inclusion,
   * since it stays part of the meaning unless the user chooses to filter by it. The entity whose
   * whole name was written is offered, not its family.
   */
  const suggestionsFor = () => {
    const suggestions: Suggestion[] = [];
    const isRemoved = (token: Token) =>
      removed.some(([start, end]) => token.start >= start && token.end <= end);

    let at = 0;

    while (at < tokens.length) {
      const name = isRemoved(tokens[at]) || afterLinkingWord.has(at) ? null : nameAt(at);
      const named = name?.entities.find((entity) => entity.matchedBy === 'NAME');

      if (!name || tokens.slice(at, name.end).some(isRemoved)) {
        at++;
        continue;
      }

      if (named && !suggestions.some((suggestion) => suggestion.value === named.entityId)) {
        suggestions.push({ kind: 'INCLUDE_ENTITY', value: named.entityId, label: named.name });
      }

      at = name.end;
    }

    return suggestions;
  };

  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    // "non-tesla": acts only on a known name, so "non-consensual" is left alone.
    if (token.word === 'non' && query.slice(token.end, tokens[index + 1]?.start) === '-') {
      const name = nameAt(index + 1);

      if (name) {
        exclude(name);
        removed.push([token.start, tokens[name.end - 1].end]);
        index = name.end;
        continue;
      }
    }

    // "-tesla": a hyphen that starts a word, unlike the one inside "self-driving".
    if (
      query[token.start - 1] === '-' &&
      (token.start === 1 || /\s/.test(query[token.start - 2]))
    ) {
      const name = nameAt(index);

      if (name) {
        exclude(name);
        removed.push([token.start - 1, tokens[name.end - 1].end]);
        index = name.end;
        continue;
      }
    }

    const phrase = phraseAt(index);

    if (!phrase) {
      const inclusion = inclusionAt(index);

      index = inclusion ? include(index, inclusion) : index + 1;
      continue;
    }

    const afterPhrase = index + phrase.words.length;
    const names = namesAt(afterPhrase, phrase.strong);
    const end = names.length > 0 ? names[names.length - 1].end : afterPhrase;

    if (names.length > 0 && (phrase.strong || endsAtBreak(end))) {
      names.forEach(exclude);
      removed.push([token.start, tokens[end - 1].end]);
      index = end;
      continue;
    }

    if (!phrase.strong) {
      index++;
      continue;
    }

    // Nothing after a strong phrase is a known name. Its words are still never searched for by
    // meaning, since that would pull the very thing to exclude towards the top.
    const stop = afterPhrase < tokens.length ? clauseEnd(afterPhrase) : afterPhrase;

    if (stop > afterPhrase) {
      warnings.push({
        code: 'UNRECOGNISED_EXCLUSION',
        text: query.slice(tokens[afterPhrase].start, tokens[stop - 1].end),
      });
    }

    removed.push([token.start, tokens[stop - 1].end]);
    index = stop;
  }

  const suggestions = suggestionsFor();

  if (removed.length === 0) return { semanticText: query, constraints, warnings, suggestions };

  let semanticText = '';
  let cursor = 0;

  for (const [start, end] of removed) {
    semanticText += `${query.slice(cursor, start)} `;
    cursor = end;
  }

  return {
    semanticText: meaningLeftIn(tidy(semanticText + query.slice(cursor))),
    constraints,
    warnings,
    suggestions,
  };
};
