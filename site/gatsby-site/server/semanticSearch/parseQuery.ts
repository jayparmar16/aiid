/**
 * Reads constraints out of a plain-English semantic search query.
 *
 * Pure: the caller supplies the vocabulary of entity names and the current time, so this module
 * never touches the network, the database or the clock. Every rule about English wording (linking
 * words, lists, plural folding, date phrases) lives here and nowhere else.
 */

export type EntityRole = 'deployer' | 'developer' | 'implicated';

/** The roles in which an organisation or system is responsible for an incident. */
export const RESPONSIBLE_ROLES: readonly EntityRole[] = ['deployer', 'developer', 'implicated'];

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
  /** The MIT risk domains, exactly as stored ("3. Misinformation"). */
  mitRiskDomains: readonly string[];
}

export interface ExcludeEntityConstraint {
  kind: 'EXCLUDE_ENTITY';
  source: 'QUERY_TEXT' | 'EXPLICIT_FILTER';
  /** The words written in the query or, for an explicit filter, the name or entity id as given. */
  matchedText: string;
  roles: readonly EntityRole[];
  entities: ResolvedEntity[];
}

/** Keeps incidents dated within inclusive `YYYY-MM-DD` bounds. A missing bound is open. */
export interface DateRangeConstraint {
  kind: 'DATE_RANGE';
  source: 'QUERY_TEXT' | 'EXPLICIT_FILTER';
  /** The date phrases written in the query, or null for an explicit filter. */
  matchedText: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

/** Never read from the query text: words only ever suggest a domain. */
export interface MitRiskDomainConstraint {
  kind: 'MIT_RISK_DOMAIN';
  source: 'EXPLICIT_FILTER';
  /** The domain exactly as given. */
  matchedText: string;
  mitRiskDomain: string;
}

export type Constraint = ExcludeEntityConstraint | DateRangeConstraint | MitRiskDomainConstraint;

export interface InterpretationWarning {
  code: 'UNRECOGNISED_EXCLUSION' | 'UNKNOWN_ENTITY' | 'INVALID_DATE' | 'UNKNOWN_MIT_DOMAIN';
  text: string;
}

/** A filter the query hints at but does not ask for, offered for the user to accept. */
export interface Suggestion {
  kind: 'MIT_RISK_DOMAIN';
  /** The value to send back as an explicit filter. */
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
const readName = (words: string[], vocabulary: Vocabulary, allowNameStart: boolean) => {
  for (const last of withSingulars(words[words.length - 1])) {
    const entities = vocabulary.resolve([...words.slice(0, -1), last], RESPONSIBLE_ROLES, {
      allowNameStart,
    });
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

/** Inclusive `YYYY-MM-DD` bounds on the incident date. A null bound is open. */
interface DateBounds {
  dateFrom: string | null;
  dateTo: string | null;
}

// Four digits outside this span are more likely a count or a model number than a year.
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const MAX_YEAR_COUNT = 200;

const DASH = /^\s*[-–]\s*$/;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const startOf = (year: number) => `${year}-01-01`;

const endOf = (year: number) => `${year}-12-31`;

const wholeYears = ([first, last]: number[]): DateBounds => ({
  dateFrom: startOf(Math.min(first, last)),
  dateTo: endOf(Math.max(first, last)),
});

/** The same day `years` earlier, or the last day of February when that year has no 29th. */
const yearsBefore = (now: Date, years: number) => {
  const year = now.getUTCFullYear() - years;
  const lastDay = new Date(Date.UTC(year, now.getUTCMonth() + 1, 0)).getUTCDate();

  return isoDay(new Date(Date.UTC(year, now.getUTCMonth(), Math.min(now.getUTCDate(), lastDay))));
};

/**
 * Each slot of a date phrase is a word, with alternatives separated by "|", YEAR for a year from
 * 1900 to 2100, COUNT for a number of years, or -YEAR for a year joined to the one before it by a
 * dash. At one position the first phrase that matches wins, so longer phrases come first.
 */
const DATE_PHRASES: { slots: string[]; bounds: (numbers: number[], now: Date) => DateBounds }[] = [
  ...[['in|during|over|within', 'the'], ['the'], ['in|during|over|within'], []].map((prefix) => ({
    slots: [...prefix, 'past|last', 'COUNT', 'years|year'],
    bounds: ([count]: number[], now: Date) => ({
      dateFrom: yearsBefore(now, count),
      dateTo: isoDay(now),
    }),
  })),
  { slots: ['between', 'YEAR', 'and', 'YEAR'], bounds: wholeYears },
  { slots: ['from', 'YEAR', 'to|until|through', 'YEAR'], bounds: wholeYears },
  { slots: ['in|during|from|between', 'YEAR', '-YEAR'], bounds: wholeYears },
  { slots: ['YEAR', '-YEAR'], bounds: wholeYears },
  ...[['in|during'], []].flatMap((prefix) => [
    {
      slots: [...prefix, 'this', 'year'],
      bounds: (_: number[], now: Date) => wholeYears([now.getUTCFullYear(), now.getUTCFullYear()]),
    },
    {
      slots: [...prefix, 'last', 'year'],
      bounds: (_: number[], now: Date) =>
        wholeYears([now.getUTCFullYear() - 1, now.getUTCFullYear() - 1]),
    },
  ]),
  {
    slots: ['since|from', 'YEAR'],
    bounds: ([year]) => ({ dateFrom: startOf(year), dateTo: null }),
  },
  {
    slots: ['after', 'YEAR'],
    bounds: ([year]) => ({ dateFrom: startOf(year + 1), dateTo: null }),
  },
  {
    slots: ['before', 'YEAR'],
    bounds: ([year]) => ({ dateFrom: null, dateTo: endOf(year - 1) }),
  },
  { slots: ['in|during', 'YEAR'], bounds: ([year]) => wholeYears([year, year]) },
];

const yearIn = (word: string) => {
  const year = /^\d{4}$/.test(word) ? Number(word) : NaN;

  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
};

const countIn = (word: string) => {
  const count = /^\d{1,3}$/.test(word) ? Number(word) : NaN;

  return count >= 1 && count <= MAX_YEAR_COUNT ? count : null;
};

/**
 * Narrows several date phrases to the dates all of them allow, so "since 2019 before 2022" reads
 * as 2019 to 2021. Phrases that leave no date at all match nothing, which the chip makes visible.
 */
const intersect = (ranges: DateBounds[]): DateBounds => ({
  dateFrom: ranges.reduce<string | null>(
    (latest, { dateFrom }) => (dateFrom && (!latest || dateFrom > latest) ? dateFrom : latest),
    null
  ),
  dateTo: ranges.reduce<string | null>(
    (earliest, { dateTo }) => (dateTo && (!earliest || dateTo < earliest) ? dateTo : earliest),
    null
  ),
});

/** Collapses the gaps and stray separators left where constraint phrases were cut out. */
const tidy = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*(?=[,.;:!?])/g, '')
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '');

/** The domain's name without its number: "Misinformation" for "3. Misinformation". */
export const mitDomainLabel = (domain: string) => domain.replace(/^\s*\d+\.\s*/, '');

const MIT_STOPWORDS = new Set(['and', 'or', 'of', 'the']);

/**
 * The word sequences that suggest each MIT risk domain, taken from its name. A name lists several
 * ideas joined by "&", "and" or commas ("Malicious Actors & Misuse"), and each idea has to be
 * written in full: on their own, words such as "AI", "system", "actors" and "harms" turn up in
 * all kinds of queries, while "malicious actors" or "misuse" point at the domain.
 */
const mitDomainPhrases = (domain: string) =>
  mitDomainLabel(domain)
    .split(/&|,|\band\b/i)
    .map((idea) => toWords(idea).filter((word) => !MIT_STOPWORDS.has(word)))
    .filter((words) => words.length > 0);

/**
 * The MIT risk domains the words name an idea of, in the order they are first named. They are
 * only ever suggested, since a hard filter would hide every incident without an MIT
 * classification.
 */
const suggestMitDomains = (tokens: Token[], vocabulary: Vocabulary): Suggestion[] => {
  const forms = tokens.map((token) => withSingulars(token.word));
  const found: { at: number; domain: string }[] = [];

  for (const domain of vocabulary.mitRiskDomains) {
    const singularPhrases = mitDomainPhrases(domain).map((words) =>
      words.map((word) => withSingulars(word))
    );
    let first = Infinity;

    for (const phrase of singularPhrases) {
      for (let start = 0; start + phrase.length <= tokens.length; start++) {
        const matches = phrase.every((wordForms, offset) =>
          forms[start + offset].some((form) => wordForms.includes(form))
        );

        if (matches) first = Math.min(first, start);
      }
    }

    if (first < Infinity) found.push({ at: first, domain });
  }

  return found
    .sort((left, right) => left.at - right.at)
    .map(({ domain }) => ({
      kind: 'MIT_RISK_DOMAIN',
      value: domain,
      label: mitDomainLabel(domain),
    }));
};

/**
 * `now` anchors "this year", "last year" and "past N years", which are counted in UTC. Several date
 * phrases combine into one date range that every one of them allows.
 */
export const parseQuery = (query: string, vocabulary: Vocabulary, now: Date): Interpretation => {
  const tokens = tokenize(query);
  const constraints: Constraint[] = [];
  const warnings: InterpretationWarning[] = [];
  const removed: [number, number][] = [];
  const dates: (DateBounds & { text: string })[] = [];

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

  /** The date phrase starting at `index`, with the token after it, or null when none does. */
  const dateAt = (index: number): (DateBounds & { end: number }) | null => {
    for (const { slots, bounds } of DATE_PHRASES) {
      const numbers: number[] = [];

      const matches = slots.every((slot, offset) => {
        const token = tokens[index + offset];
        if (!token) return false;

        const gap = offset > 0 ? gapBefore(index + offset) : '';
        if (slot === '-YEAR' ? !DASH.test(gap) : BREAK.test(gap)) return false;

        if (!['YEAR', '-YEAR', 'COUNT'].includes(slot)) return slot.split('|').includes(token.word);

        const number = slot === 'COUNT' ? countIn(token.word) : yearIn(token.word);
        if (number !== null) numbers.push(number);

        return number !== null;
      });

      if (matches) return { end: index + slots.length, ...bounds(numbers, now) };
    }

    return null;
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
  const nameAt = (start: number, allowNameStart = false): NameMatch | null => {
    const longest = Math.min(vocabulary.longestNameWords, tokens.length - start);

    for (let count = longest; count > 0; count--) {
      const end = start + count;
      const crossesBreak = tokens
        .slice(start + 1, end)
        .some((_, offset) => NAME_BREAK.test(gapBefore(start + 1 + offset)));
      if (crossesBreak) continue;

      const words = tokens.slice(start, end).map((token) => token.word);
      const entities = readName(words, vocabulary, allowNameStart);

      if (entities.length > 0) return { start, end, entities };
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

  /**
   * Whether a token range ending at `end` is followed by the end, punctuation, a linking word or a
   * date phrase, so "not tesla since 2020" ends its name where the date begins.
   */
  const endsAtBreak = (end: number) =>
    end >= tokens.length ||
    BREAK.test(gapBefore(end)) ||
    Boolean(phraseAt(end)) ||
    Boolean(dateAt(end));

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

    // Read before linking words, so that "from" followed by a year is a date.
    const date = dateAt(index);

    if (date) {
      const text = query.slice(token.start, tokens[date.end - 1].end);

      dates.push({ dateFrom: date.dateFrom, dateTo: date.dateTo, text });
      removed.push([token.start, tokens[date.end - 1].end]);
      index = date.end;
      continue;
    }

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

  if (dates.length > 0) {
    constraints.push({
      kind: 'DATE_RANGE',
      source: 'QUERY_TEXT',
      matchedText: dates.map(({ text }) => text).join(', '),
      ...intersect(dates),
    });
  }

  // Words taken out as constraints, such as "excluding misinformation", suggest nothing.
  const suggestions = suggestMitDomains(
    tokens.filter(
      (token) => !removed.some(([start, end]) => token.start >= start && token.end <= end)
    ),
    vocabulary
  );

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
