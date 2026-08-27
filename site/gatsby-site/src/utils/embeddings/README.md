# Incident Embeddings

This directory holds the embedding pipeline: a batch job that turns every incident into a
single vector and stores it in MongoDB, so incidents can be compared by meaning rather
than by keyword.

An incident document has no article body of its own, only a `title`. The text worth
embedding lives on its reports, reached through the `incidents.reports` array of
`report_number` join keys. The pipeline joins the two, embeds the result, and writes one
document per incident to `aiidprod.incident_embeddings`.

This is separate from the per-report embeddings the site already uses for the
"Most Semantically Similar Incidents" panel. Those are generated at submission time and
stored on each report. These are generated in bulk, for the whole corpus, from a model
that is configured entirely through environment variables.

## What It Does

For each incident:

1. Reads the incident and every report it links to.
2. Joins the title and the report bodies into one string, with reports sorted by
   `report_number` so the same incident produces byte-identical input on every run.
3. Splits that string into chunks at paragraph boundaries if it exceeds the character
   budget. At the default budget about 44% of incidents fit in a single chunk, and the
   whole corpus of roughly 1,550 incidents becomes roughly 4,600 chunks.
4. Sends all chunks in one request. The API accepts an array and returns one embedding
   per element, so a chunked incident is still a single call.
5. Averages the chunk vectors component-wise and normalises the result to unit length.
   This is the same pooling that `server/fields/common.ts:incidentEmbedding` performs
   when it combines sibling report vectors.
6. Upserts the vector into `incident_embeddings`, keyed on `incident_id`.

Every incident is written the moment it completes, so an interrupted run keeps everything
it had already finished.

## Key Files

| File | Purpose |
|---|---|
| `src/scripts/embed-incidents.ts` | The runner. Reads the database, drives concurrency, writes results, handles interruption. |
| `src/utils/embeddings/provider.ts` | The only file that knows about the vendor. Builds the request, retries, and backs off. |
| `src/utils/embeddings/incidentText.ts` | Pure text and vector helpers. No network, no database. |
| `.github/workflows/embed-incidents.yml` | The manually triggered GitHub Action. |
| `server/tests/embeddings.spec.ts` | Unit tests for the pure helpers. |

## Running It Locally

You need a MongoDB with incident data and an API key for the embedding endpoint. Put both
in `site/gatsby-site/.env`:

```bash
MONGODB_CONNECTION_STRING=mongodb://127.0.0.1:4110
EMBEDDING_API_KEY=your-key-here
```

Then, from `site/gatsby-site`:

```bash
npm run embed-incidents -- --limit 5      # small live test
npm run embed-incidents -- --incident-id 1 --incident-id 2
npm run embed-incidents                   # the whole corpus
npm run embed-incidents -- --resume       # skip what is already embedded
```

There are only three options, because everything else is configuration rather than a
choice you make per run:

| Option | Effect |
|---|---|
| `--limit N` | Process at most the first N incidents. |
| `--incident-id N` | Only these incidents. Repeatable. |
| `--resume` | Skip incidents already embedded with the current model. |

A full run of roughly 1,550 incidents takes about three and a half minutes at a
concurrency of 3.

## Running It From GitHub Actions

The workflow is **Embed Incidents** (`.github/workflows/embed-incidents.yml`). It is
triggered manually: open the Actions tab, select the workflow, and choose "Run workflow".

| Field | Required | Notes |
|---|---|---|
| `environment` | Yes | Which GitHub environment to load secrets and variables from, and therefore **which database gets written to**. Use `production` or `staging`. |
| `limit` | No | Process at most this many incidents. Blank means all. |
| `resume` | No | Tick to skip incidents already embedded with the current model. |

The job checks out the repo, installs Node LTS and dependencies, and runs the script. It
allows up to 300 minutes, because a free-tier endpoint under rate limiting can stretch a
full run, and every incident is checkpointed so a timeout is always recoverable.

Whether the run passes or fails, the job uploads `embed-failures.json` as an artifact
named `embed-failures` if the script produced one. If a run fails, download that artifact
to see which incidents failed and why, then re-run with `resume` ticked.

## Configuration

Everything is set through the environment. Locally that means `.env`; in CI it means
secrets and variables on the GitHub environment named by the `environment` input.

| Name | Type | Default | Purpose |
|---|---|---|---|
| `MONGODB_CONNECTION_STRING` | secret | none, required | Read and write access to the `aiidprod` database. |
| `EMBEDDING_API_KEY` | secret | none, required | Bearer token for the embedding endpoint. |
| `EMBEDDING_API_BASE_URL` | variable | `https://openrouter.ai/api/v1` | Base URL of an OpenAI-compatible embeddings API. |
| `EMBEDDING_MODEL` | variable | `nvidia/nemotron-3-embed-1b:free` | Model identifier, passed straight through. |
| `EMBEDDING_MAX_INPUT_CHARS` | variable | `8000` | Chunk size in characters. See the note below. |
| `EMBEDDING_CONCURRENCY` | variable | `2` | Incidents embedded in parallel. This is the main pacing control against a rate-limited endpoint. |
| `EMBEDDING_TIMEOUT_MS` | variable | `120000` | Per-request timeout. |
| `EMBEDDING_MAX_ATTEMPTS` | variable | `6` | Attempts per request before giving up on an incident. |

The defaults are the settings that work against the current model, so a run needs nothing
but the two secrets.

`EMBEDDING_MAX_INPUT_CHARS` is worth understanding before changing it. The real limit is
in tokens, not characters, and the ratio varies from roughly 4 characters per token for
Latin prose to close to 1 for Chinese or Japanese. The default of 8,000 is deliberately
conservative for a 4,096-token model. If the server rejects a request as too long anyway,
the script reads the token counts out of the error and re-chunks that incident at a
smaller budget, up to three times, rather than failing it.

## What Gets Stored

One document per incident in `aiidprod.incident_embeddings`, with a unique index on
`incident_id`:

```js
{
  incident_id: 1,
  vector: [0.0143, -0.0271, ...],            // 2048 floats, unit length
  dims: 2048,
  model: 'nvidia/nemotron-3-embed-1b:free',
  base_url: 'https://openrouter.ai/api/v1',
  chunks: 10,                                 // chunks pooled into this vector
  source_chars: 72787,                        // length of the joined text
  generated_at: ISODate('2026-08-25T16:18:07Z')
}
```

Writes are upserts keyed on `incident_id`, so re-running never duplicates a row. `model`
is what `--resume` compares against, which means changing the model correctly causes a
resumed run to re-embed everything.

## Failure Handling

The endpoint may be free-tier, rate limited, and slow, so the script assumes failure is
normal:

- **Retries.** 408, 425, 429, 500, 502, 503 and 504 are retried with exponential backoff
  and jitter. A `Retry-After` header is honoured up to a 60-second ceiling. Anything else
  fails immediately with the response body attached, because retrying a request the
  server has rejected only wastes minutes and buries the real error.
- **Checkpointing.** Each incident is written as soon as it succeeds. Nothing is batched
  or held until the end.
- **Quota exhaustion.** If the server asks for a `Retry-After` longer than the ceiling,
  the run stops rather than sleeping. Finished work is already stored, so coming back
  later with `--resume` is cheaper than waiting.
- **Circuit breaker.** Ten consecutive failures stop the run, so a broken key or a dead
  endpoint does not work through the whole corpus to rediscover the same error.
- **Interruption.** `SIGINT` and `SIGTERM` let in-flight requests finish, then stop and
  print the summary. A second Ctrl-C kills the process outright.
- **Failure manifest.** Any failure is appended to `embed-failures.json` and the file is
  rewritten immediately, so even a hard kill leaves the list behind.

Recovery is always the same command, which the script prints for you:

```bash
npm run embed-incidents -- --resume
```

Anything that failed was never stored, so a resumed run retries it as a matter of course.

| Exit code | Meaning |
|---|---|
| `0` | Every incident succeeded. |
| `1` | At least one incident failed, or the run stopped early. |
| `130` | Interrupted by a signal. |

## Changing The Model Or Provider

Set `EMBEDDING_MODEL`. If the new model lives somewhere else, set
`EMBEDDING_API_BASE_URL` too. No code changes are needed for any endpoint that speaks the
OpenAI embeddings shape:

```
POST {baseUrl}/embeddings  {model, input}  ->  {data: [{embedding, index}]}
```

Check `EMBEDDING_MAX_INPUT_CHARS` against the new model's token limit, and expect the
next run to re-embed the whole corpus, since `--resume` keys on the model name. Vectors
of different dimensions are stored side by side without complaint, so compare only
vectors that share a `model` value.

## Tests

The pure helpers are covered by `server/tests/embeddings.spec.ts`, which needs no network
and no database:

```bash
npm run test:api -- embeddings
```
