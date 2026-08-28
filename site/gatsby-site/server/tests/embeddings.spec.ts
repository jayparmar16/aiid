/**
 * Unit tests for the pure helpers behind the embedding pipeline. These cover text building,
 * chunking, vector pooling, and Retry-After parsing, none of which touch the network or the
 * database, so the suite runs fast and deterministically.
 */

import { describe, expect, it } from '@jest/globals';

import { buildIncidentText, chunkText, poolVectors } from '../../src/utils/embeddings/incidentText';
import { parseRetryAfter } from '../../src/utils/embeddings/provider';

// Length of a vector, used to check that pooled vectors come back normalised.
const magnitude = (vector: number[]) =>
  Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));

describe('buildIncidentText', () => {
  it('orders report bodies by report_number, whatever order they arrive in', () => {
    const text = buildIncidentText({ title: 'Title' }, [
      { report_number: 3, plain_text: 'third' },
      { report_number: 1, plain_text: 'first' },
      { report_number: 2, plain_text: 'second' },
    ]);

    expect(text).toBe('Title\n\nfirst\n\nsecond\n\nthird');
  });

  it('prefers plain_text over the raw text field', () => {
    const text = buildIncidentText({ title: 'Title' }, [
      { report_number: 1, plain_text: 'clean', text: '<p>markup</p>' },
      { report_number: 2, text: 'fallback' },
    ]);

    expect(text).toBe('Title\n\nclean\n\nfallback');
  });

  it('drops reports with no usable body', () => {
    const text = buildIncidentText({ title: 'Title' }, [
      { report_number: 1, plain_text: '   ' },
      { report_number: 2, plain_text: 'kept' },
      { report_number: 3 },
    ]);

    expect(text).toBe('Title\n\nkept');
  });

  it('returns the title alone when there are no reports', () => {
    expect(buildIncidentText({ title: 'Title' }, [])).toBe('Title');
  });

  it('returns an empty string when there is nothing to embed', () => {
    expect(buildIncidentText({ title: '  ' }, [{ report_number: 1, plain_text: '' }])).toBe('');
  });
});

describe('chunkText', () => {
  it('returns a single chunk when the text already fits', () => {
    expect(chunkText('short', 100)).toEqual(['short']);
  });

  it('returns no chunks for empty text', () => {
    expect(chunkText('', 100)).toEqual([]);
  });

  it('splits on paragraph boundaries rather than mid-sentence', () => {
    const chunks = chunkText('aaaa\n\nbbbb\n\ncccc', 10);

    expect(chunks).toEqual(['aaaa\n\nbbbb', 'cccc']);
  });

  it('hard-splits a single paragraph that is longer than the budget', () => {
    const chunks = chunkText('x'.repeat(25), 10);

    expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('never emits a chunk larger than the budget', () => {
    const paragraphs = ['y'.repeat(30), 'z'.repeat(5), 'w'.repeat(17)].join('\n\n');
    const chunks = chunkText(paragraphs, 12);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
  });

  it('rejects a budget of zero or less', () => {
    expect(() => chunkText('anything', 0)).toThrow('maxChars must be greater than zero');
  });
});

describe('poolVectors', () => {
  it('normalises a single vector to unit length', () => {
    expect(poolVectors([[3, 4]])).toEqual([0.6, 0.8]);
  });

  it('averages several vectors and normalises the result', () => {
    const pooled = poolVectors([
      [1, 0],
      [0, 1],
    ]);

    expect(pooled[0]).toBeCloseTo(Math.SQRT1_2);
    expect(pooled[1]).toBeCloseTo(Math.SQRT1_2);
    expect(magnitude(pooled)).toBeCloseTo(1);
  });

  it('returns a zero vector unchanged, since it has no direction', () => {
    expect(poolVectors([[0, 0, 0]])).toEqual([0, 0, 0]);
  });

  it('rejects vectors of differing dimensions', () => {
    expect(() =>
      poolVectors([
        [1, 2],
        [1, 2, 3],
      ])
    ).toThrow('differing dimensions');
  });

  it('rejects an empty set', () => {
    expect(() => poolVectors([])).toThrow('cannot pool an empty set');
  });
});

describe('parseRetryAfter', () => {
  it('reads the delta-seconds form', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
  });

  it('treats zero as retry immediately, not as a missing header', () => {
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads the HTTP-date form', () => {
    const parsed = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString());

    expect(parsed).toBeGreaterThan(58_000);
    expect(parsed).toBeLessThanOrEqual(60_000);
  });

  it('clamps a date already in the past to zero', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it('returns null for a missing or unparseable header', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not a date')).toBeNull();
  });
});
