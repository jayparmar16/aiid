/** Representation settings shared by ingestion and readers of its schema-v2 corpus. */
import { createHash } from 'crypto';
import { getEmbeddingProviderSettings, type EmbeddingProvider } from './provider';

export const EMBEDDING_SCHEMA_VERSION = 2;
export const EMBEDDINGS_COLLECTION = 'incident_embeddings';

export interface EmbeddingIndexConfig {
  model: string;
  baseUrl: string;
  profileId: string;
  maxInputChars: number;
  overlapChars: number;
  indexSignature: string;
}

const positiveInteger = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

/** Keeps the existing signature format so extracting this helper does not invalidate a backfill. */
export const getEmbeddingIndexConfig = (
  provider: Pick<EmbeddingProvider, 'model' | 'baseUrl' | 'profileId'>
): EmbeddingIndexConfig => {
  const maxInputChars = positiveInteger(
    process.env.EMBEDDING_MAX_INPUT_CHARS,
    8000,
    'EMBEDDING_MAX_INPUT_CHARS'
  );
  const overlapChars = positiveInteger(
    process.env.EMBEDDING_CHUNK_OVERLAP_CHARS,
    200,
    'EMBEDDING_CHUNK_OVERLAP_CHARS'
  );
  if (overlapChars >= maxInputChars) {
    throw new Error('EMBEDDING_CHUNK_OVERLAP_CHARS must be smaller than EMBEDDING_MAX_INPUT_CHARS');
  }

  const indexSignature = createHash('sha256')
    .update(
      JSON.stringify({
        schema: EMBEDDING_SCHEMA_VERSION,
        model: provider.model,
        baseUrl: provider.baseUrl,
        profile: provider.profileId,
        maxInputChars,
        overlapChars,
      })
    )
    .digest('hex');

  return {
    model: provider.model,
    baseUrl: provider.baseUrl,
    profileId: provider.profileId,
    maxInputChars,
    overlapChars,
    indexSignature,
  };
};

/** Build-time readers use the same environment/defaults as ingestion, without an API key. */
export const getConfiguredEmbeddingIndex = (): EmbeddingIndexConfig =>
  getEmbeddingIndexConfig(getEmbeddingProviderSettings());

export const getEmbeddingIndexFilter = (index: EmbeddingIndexConfig, dimensions?: number) => ({
  embedding_schema_version: EMBEDDING_SCHEMA_VERSION,
  embedding_profile: index.profileId,
  model: index.model,
  base_url: index.baseUrl,
  index_signature: index.indexSignature,
  ...(dimensions === undefined ? {} : { dims: dimensions }),
});
