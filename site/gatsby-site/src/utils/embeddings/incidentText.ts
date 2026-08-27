/**
 * Builds the text that represents an incident, and pools chunk vectors back into one.
 *
 * An incident stores only a title, and the article text lives on its reports. Those are
 * reached through the `incidents.reports` array of report_number join keys.
 */

// Both carry an index signature so raw driver documents satisfy them without a cast.
export type IncidentTextSource = {
  title?: string | null;
  [key: string]: unknown;
};

export type ReportTextSource = {
  report_number?: number | null;
  plain_text?: string | null;
  text?: string | null;
  [key: string]: unknown;
};

/** Joins the title and every report body into the text to embed. */
export const buildIncidentText = (
  incident: IncidentTextSource,
  reports: readonly ReportTextSource[]
): string => {
  const title = (incident.title || '').trim();

  // Sorting by report_number keeps the text identical across runs so the vector is stable.
  const bodies = [...reports]
    .sort((a, b) => (a.report_number ?? 0) - (b.report_number ?? 0))
    .map((report) => (report.plain_text || report.text || '').trim())
    .filter((body) => body.length > 0);

  return [title, ...bodies].filter((part) => part.length > 0).join('\n\n');
};

/**
 * Splits text into chunks of at most `maxChars`, preferring paragraph boundaries.
 *
 * Returns the text untouched in a single-element array when it already fits. At the
 * default 8,000-char budget that covers about 44% of the corpus.
 */
export const chunkText = (text: string, maxChars: number): string[] => {
  if (maxChars <= 0) throw new Error('maxChars must be greater than zero');

  if (text.length <= maxChars) return text.length > 0 ? [text] : [];

  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    // A single paragraph longer than the budget has to be hard-split.
    if (paragraph.length > maxChars) {
      flush();

      for (let i = 0; i < paragraph.length; i += maxChars) {
        chunks.push(paragraph.slice(i, i + maxChars));
      }

      continue;
    }

    // A new chunk starts when adding this paragraph would push the buffer over the budget.
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;

    if (candidate.length > maxChars) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  flush();

  return chunks;
};

/**
 * Component-wise mean of the chunk vectors, then L2-normalised.
 *
 * Same averaging as `server/fields/common.ts:incidentEmbedding`, which pools sibling
 * report vectors into an incident vector. Normalising keeps cosine similarity comparable
 * between incidents that needed different chunk counts.
 */
export const poolVectors = (vectors: number[][]): number[] => {
  if (vectors.length === 0) throw new Error('cannot pool an empty set of vectors');

  const dims = vectors[0].length;

  if (vectors.some((vector) => vector.length !== dims)) {
    throw new Error('cannot pool vectors of differing dimensions');
  }

  if (vectors.length === 1) return normalise(vectors[0]);

  const mean = new Array(dims).fill(0);

  for (const vector of vectors) {
    for (let i = 0; i < dims; i++) {
      mean[i] += vector[i];
    }
  }

  for (let i = 0; i < dims; i++) {
    mean[i] /= vectors.length;
  }

  return normalise(mean);
};

const normalise = (vector: number[]): number[] => {
  const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));

  // A zero vector has no direction to preserve, so return it unchanged.
  return magnitude === 0 ? [...vector] : vector.map((component) => component / magnitude);
};
