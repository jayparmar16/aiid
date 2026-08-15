# Embeddings: how they work today, and notes toward replacing them

Reference document for anyone working on semantic search / vector retrieval in AIID.
Written while investigating why free-text topical search performs poorly.

---

## 1. The problem

Every report and incident carries an `embedding.vector` (768-D) produced by **AllenAI
Longformer** via a self-hosted AWS Lambda.

These vectors are **anisotropic**: the raw cosine similarity between any two incidents sits at
~0.99 regardless of topic. Measured against the production corpus, using incident #123 (Epic
Systems sepsis prediction) as the anchor:

| Compared against | Topic | Raw cosine | After mean-centering |
|---|---|---|---|
| #124 Optum health risk scores | health | 0.9994 | **0.7864** |
| #79 Kidney testing method | health | 0.9986 | **0.5931** |
| #5 Robotic surgery malfunctions | health | 0.9990 | **0.6310** |
| #293 Cruise self-driving collision | unrelated | 0.9981 | **0.1398** |
| #1214 Trump deepfake video | unrelated | 0.9925 | **-0.2004** |

The signal is real but compressed into a band ~0.018 wide (std 0.0019 across all incidents).
Consequences:

- A similarity **threshold** is effectively unusable — "relevant" and "irrelevant" differ in
  the third decimal place, and any cutoff fails to generalise across queries.
- **Free-text topical search fails.** A "public health" query returns deepfake and robotics
  incidents at the top.
- Mean-centering (subtracting the average vector from all vectors before comparing) stretches
  the same signal ~100x (std 0.19) and restores usable ranking. This is a workaround, not a fix.

**Why:** Longformer was trained to read one long document at a time, not to place similar texts
near each other. Purpose-built embedding models are trained with that objective directly and do
not need the centering trick.

**Where this is reproducible:** `site/excel-export-pipeline/embedding_behaviour_test.ipynb`
(numpy + bson only; reads a mongodump directly, no DB or credentials required).

### What the current system is actually good at
The infrastructure was built and validated for **incident-to-incident deduplication** and
reports ~94% leave-one-out accuracy at that task. Incident→incident nearest-neighbour search
works well. It is **text→incident topical retrieval** that is weak. Keep that distinction in
mind before concluding the embeddings are simply "bad".

---

## 2. How `embedding` gets populated today

### Reports — the vector is generated in the browser, not on the server

There is no server-side embedder. The vector is a side effect of a UI widget.

1. An editor types into the submit form. `src/components/SemanticallyRelatedIncidents.js` runs a
   **debounced** effect on the report text.
2. **Guard (lines 68-83):** the text must be **≥ 256 non-space characters**, otherwise it
   refuses and no vector is produced.
3. It calls `/api/semanticallyRelated` → `netlify/functions/semanticallyRelated.ts` → the AWS
   Longformer Lambda (`/text-to-embed`, then `/embed-to-db-similar`).
4. **Line 103:** `setFieldValue('embedding', nlpResponse.embedding)` — the vector goes into
   **form state**.
5. `src/components/forms/SubmitForm.js:192` sends it into `insertOneSubmission`, so it lands on
   the **submission** document.
6. `promoteSubmissionToReport` (`server/fields/submissions.ts:242-243`) copies it verbatim onto
   the new report.

Two consequences worth knowing:
- `server/fields/reports.ts` contains **zero** references to `embedding`. Editing a report's
  text later does **not** regenerate its vector, so vectors drift out of sync with their text.
- If the widget never fires (text < 256 chars, or the editor skips that step) the report has no
  vector at all. **976 of 7,266 reports (~13%) have none.**

### Incidents — never embedded from their own text

An incident vector is always **derived from its member reports**. Exactly two writers:

- `server/fields/submissions.ts:114-119` — a promotion creating a *new* incident seeds it with
  that single report's vector:
  `newIncident.embedding = { vector: submission.embedding.vector, from_reports: [report_number] }`
- `server/fields/common.ts:5-20` — `incidentEmbedding(reports)` computes the **plain arithmetic
  mean** of member report vectors (note: **not re-normalized**) plus `from_reports`. If no
  member report has a vector, it `$unset`s the field entirely.

`incidentEmbedding` runs inside `linkReportsToIncidents` (`common.ts:22-79`), called from three
places: `server/fields/incidents.ts:64` (the editor's link/unlink mutation),
`server/fields/reports.ts:247`, and `server/fields/submissions.ts:255`.

### When is it triggered?

There is **no trigger on incident creation as such, and no cron, queue, or background job
anywhere.** The vector is written **synchronously inside the GraphQL mutation** — either copied
from the submission at promote time, or recomputed whenever reports are linked to / unlinked
from that incident.

### Field shapes (verified against the production dump)
```
report.embedding   = { vector: [768 floats], from_text_hash: <sha256 of source text> }
incident.embedding = { vector: [768 floats], from_reports: [report numbers] }
```
Note `from_text_hash` — the existing system already does change-detection by hashing source
text. A good pattern to reuse.

---

## 3. Corpus size (measured, not estimated)

- **7,266 reports.** `plain_text` holds the article body (mirrored in `text`).
- Title + body = **~31.6M characters ≈ 7–8M tokens**; average article **~4,350 chars (~1,100 tokens)**.
- Longest article ~50,000 chars (~12.5K tokens). **Only ~23 articles exceed 8K tokens**, so an
  8K-context model truncates ~0.3% of the corpus; a 32K-context model truncates nothing.
- **1,549 incidents**, 1,548 with a vector.
- Language mix: **96.6% English** (7,022 `en`); small tail (es 58, it 26, de 22, zh-CN 21, fr 18,
  others). Multilingual capability is a minor consideration.

---

## 4. Replacement notes

### OpenRouter embeddings (verified Aug 2026)

- **Endpoint:** `POST https://openrouter.ai/api/v1/embeddings`
- **Headers:** `Authorization: Bearer <OPENROUTER_API_KEY>`, `Content-Type: application/json`
- **Body:** `{ "model": "...", "input": "..." | ["...","..."], "encoding_format": "float" }` —
  `input` accepts an **array**, so batching is supported.
- **Response:** `{ "data": [ { "embedding": [...], "index": 0 }, ... ] }`
- OpenAI-schema compatible; any OpenAI SDK works by changing `base_url` and key.
- Docs state no explicit rate limit or max batch size — implement **429 + exponential backoff**.

| Model | Context | Price /M tok | Est. full corpus (~8M tok) |
|---|---|---|---|
| `nvidia/nemotron-3-embed-1b` | 33K | Free | $0 |
| `qwen/qwen3-embedding-8b` | 33K | $0.01 | ~$0.08 |
| `baai/bge-m3` (1024-D) | 8K | $0.01 | ~$0.08 |
| `qwen/qwen3-embedding-4b` | 33K | $0.02 | ~$0.16 |
| `openai/text-embedding-3-small` | 8K | $0.02 | ~$0.16 |
| `mistral/mistral-embed-2312` (1024-D) | 8K | $0.10 | ~$0.80 |
| `openai/text-embedding-3-large` | 8K | $0.13 | ~$1.04 |
| `google/gemini-embedding-2` (128–3072 flexible) | 8K | $0.20 | ~$1.60 |

A full re-embed costs well under $2. **Cost is not a deciding factor at this corpus size** —
choose on quality and context length.

Query-side cost is negligible: one short embedding call per search (~$0.20–$1.30 per 100k
searches). The similarity math itself is free — all incident vectors total ~5 MB, so a
brute-force numpy cosine runs in milliseconds and needs no vector database at this scale.

### Decisions a replacement needs to make

1. **Model** — context length is the real differentiator (8K truncates ~23 articles; 32K none).
2. **Dimensions** — must match what is stored; some models allow truncation (Gemini 128–3072).
3. **Storage** — new field alongside `embedding`, or a separate collection. Either way, leave
   the existing `embedding` field and its write paths untouched so the two can be A/B compared.
4. **Incident vectors** — average the report vectors (mirroring today's `from_reports`), or embed
   incident title + description directly? These give materially different results.
5. **Idempotency** — reuse the `from_text_hash` change-detection pattern.
6. **Query/document asymmetry** — several models (Qwen3, BGE, Nomic) expect a *different* prefix
   or instruction for queries vs documents. Check the model card.
7. **Ongoing updates** — backfill only, or hook into ingestion? Relevant hooks:
   `server/fields/reports.ts` (`onResolve`), `server/fields/submissions.ts`
   (`promoteSubmissionToReport`), `server/fields/common.ts` (`incidentEmbedding`).
8. **Batching and failure handling** — batch size, 429 backoff, resume after partial failure.

### Traps

- **Query/document asymmetry (6 above)** is the easiest way to build something that looks
  finished and retrieves badly.
- **Don't validate with a single keyword query.** The current system scores ~0.99 on everything
  and *still* ranks the correct incident first. Use a **contrast** test — related and unrelated
  incidents must separate on raw cosine — rather than eyeballing a top-1 hit.
- **A new vector field goes stale unless the write path is touched.** `common.ts` recomputes
  `incidents.embedding` on every report link/unlink and `promoteSubmissionToReport` writes
  `embedding` for new reports; neither knows about a second field. Decide explicitly whether a
  new field is a throwaway experiment, periodically rebuilt by a scheduled job, or maintained
  live alongside the existing one.
- **Don't copy the current design's weaknesses by reflex** — vectors never regenerated on text
  edit, ~13% coverage gap, unnormalized averaging. A server-side batch embedder can fix all three.

---

## 5. Reading list

### Data model
| File | Why |
|---|---|
| `site/excel-export-pipeline/MAINTENANCE_GUIDE.md` | "Data Model → Core collections". Fastest orientation in the repo. |
| `site/gatsby-site/server/types/report.ts` | Canonical report schema: `plain_text`, `text`, `title`, `embedding`. |
| `site/gatsby-site/server/types/types.ts` (lines 11-25) | `EmbeddingType` / `IncidentEmbeddingType` GraphQL definitions. |
| `site/gatsby-site/playwright/seeds/aiidprod/incidents.ts` | Concrete example docs showing the real `embedding` shape. |

### The existing system
| File | Why |
|---|---|
| `site/gatsby-site/blog/using-ai-to-connect-ai-incidents/index.mdx` | The original team's writeup — Longformer, CLS embeddings, the 2,000-token cap, the 94% dedup figure. Read the Appendix. |
| `site/gatsby-site/netlify/functions/semanticallyRelated.ts` | How the site calls the embedding Lambda today. |
| `site/gatsby-site/migrations/2022.06.23T21.14.51.add-similar-incidents.js` | Precedent for a bulk backfill migration. |
| `site/gatsby-site/src/components/SemanticallyRelatedIncidents.js` | Where the vector is actually born (debounce, 256-char guard). |
| `site/gatsby-site/server/fields/common.ts` | `incidentEmbedding` + `linkReportsToIncidents` (the recompute trigger). |
| `site/gatsby-site/server/fields/submissions.ts` | `promoteSubmissionToReport`. |
| `site/gatsby-site/src/utils/updateTsne.js` | Closest existing pattern for a batch job over all incident embeddings. |

### Config, secrets, CI
| File | Why |
|---|---|
| `site/gatsby-site/.env.example` | Canonical key list for the site. A new provider key belongs here. |
| `site/excel-export-pipeline/src/config.py` (lines 92-116) | The env-override pattern to follow for a new key. |
| `.github/workflows/excel-export-pipeline.yml` | Weekly cron + secret passing; the file to extend for a scheduled embedding job. |

### Testing reality
There is **no pytest config**, `pytest` is not in `requirements.txt`, and no CI workflow runs
tests. `MAINTENANCE_GUIDE.md` states: "There is no automated test suite — run the pipeline
end-to-end to validate changes." The convention is self-running `python test_*.py` scripts.

### Local data
`data/snapshots/.../mongodump_full_snapshot/aiidprod/*.bson` (gitignored). Read directly with
`bson.decode_file_iter` (ships with pymongo) — no database or credentials needed.

---

## Sources
- <https://openrouter.ai/docs/api-reference/embeddings>
- <https://openrouter.ai/collections/embedding-models>
