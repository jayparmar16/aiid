/**
 * Reads constraints out of a plain-English semantic search query.
 *
 * Pure: the caller supplies the vocabulary of entity names, so this module never touches the
 * network or the database. Every rule about English wording (linking words, lists, plural
 * folding) lives here and nowhere else.
 */

export type EntityRole = 'deployer' | 'developer' | 'implicated';

/** The roles in which an organisation or system is responsible for an incident. */
export const RESPONSIBLE_ROLES: readonly EntityRole[] = ['deployer', 'developer', 'implicated'];

export interface ResolvedEntity {
  entityId: string;
  name: string;
  /** NAME when the entity's whole name was written, FAMILY when its name contains what was written. */
  matchedBy: 'NAME' | 'FAMILY';
}

export interface Vocabulary {
  /**
   * The entities occurring in `roles` that a name written as `words` covers, or an empty list when
   * the words are not a known name or none of the covered entities occurs in those roles. A known
   * name is an entity's whole name or, with `allowNameStart`, the first words of one ("clearview"
   * for "Clearview AI").
   */
  resolve: (
    words: string[],
    roles: readonly EntityRole[],
    options?: { allowNameStart?: boolean }
  ) => ResolvedEntity[];
  /** The most words in any entity name, which bounds the longest-match search. */
  longestNameWords: number;
}

export interface ExcludeEntityConstraint {
  kind: 'EXCLUDE_ENTITY';
  source: 'QUERY_TEXT' | 'EXPLICIT_FILTER';
  /** The words written in the query or, for an explicit filter, the filtered entity's name. */
  matchedText: string;
  roles: readonly EntityRole[];
  entities: ResolvedEntity[];
}

export type Constraint = ExcludeEntityConstraint;

export interface InterpretationWarning {
  code: 'UNRECOGNISED_EXCLUSION' | 'UNKNOWN_ENTITY';
  text: string;
}

export interface Interpretation {
  /** What is left to rank by meaning. Equal to the query when no constraint was read. */
  semanticText: string;
  constraints: Constraint[];
  warnings: InterpretationWarning[];
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

  const skipArticles = (index: number) => {
    while (index < tokens.length && ARTICLES.has(tokens[index].word)) index++;
    return index;
  };

  /**
   * The longest known name starting at `start`, trying singular forms of its last word. Only a
   * strong phrase accepts the start of a name, because the everyday words that weak phrases and
   * prefixes catch ("not work", "non-consensual") often begin some entity's name.
   */
  const nameAt = (start: number, allowNameStart = false): NameMatch | null => {
    const longest = Math.min(vocabulary.longestNameWords, tokens.length - start);

    for (let count = longest; count > 0; count--) {
      const end = start + count;
      const crossesBreak = tokens
        .slice(start + 1, end)
        .some((_, offset) => NAME_BREAK.test(gapBefore(start + 1 + offset)));
      if (crossesBreak) continue;

      const words = tokens.slice(start, end).map((token) => token.word);

      for (const last of withSingulars(words[count - 1])) {
        const entities = vocabulary.resolve([...words.slice(0, -1), last], RESPONSIBLE_ROLES, {
          allowNameStart,
        });
        if (entities.length > 0) return { start, end, entities };
      }
    }

    return null;
  };

  /** Reads "tesla", "tesla and uber" or "tesla, waymo, or uber", stopping at an unknown name. */
  const namesAt = (start: number, allowNameStart: boolean): NameMatch[] => {
    const names: NameMatch[] = [];
    let at = skipArticles(start);

    while (at < tokens.length) {
      const name = nameAt(at, allowNameStart);
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
    end >= tokens.length || BREAK.test(gapBefore(end)) || Boolean(phraseAt(end));

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
      index++;
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

  if (removed.length === 0) return { semanticText: query, constraints, warnings };

  let semanticText = '';
  let cursor = 0;

  for (const [start, end] of removed) {
    semanticText += `${query.slice(cursor, start)} `;
    cursor = end;
  }

  return { semanticText: tidy(semanticText + query.slice(cursor)), constraints, warnings };
};
