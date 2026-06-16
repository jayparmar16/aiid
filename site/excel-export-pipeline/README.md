# AIID Excel Export Pipeline

Builds the AI Incident Database Excel Export: a multi-sheet Excel workbook joining incident records with taxonomy classifications (MIT, GMF, CSETv1), alongside separate relational sheets for Reports and Entities. Runs weekly via GitHub Actions and uploads to Cloudflare R2.

**Why this exists:** it gives researchers, analysts, and journalists the whole database as a single, offline spreadsheet — no API, GraphQL, or MongoDB knowledge required. It complements the live [public GraphQL endpoint](../../README.md#public-graphql-endpoint) for people who'd rather work in Excel or a notebook than write queries.

> This README covers how to **run** the pipeline, its architecture, and the **output workbook's sheets/columns** (see [What the Output Looks Like](#what-the-output-looks-like)). To **extend** the pipeline (new columns, taxonomies, cleaning hooks) and understand the **raw MongoDB data model**, read the [Maintenance & Developer Guide](MAINTENANCE_GUIDE.md).

---

## What It Does

1. Downloads the latest `.tar.bz2` database snapshot from `incidentdatabase.ai`.
2. Extracts 5 core BSON collections: `incidents`, `reports`, `entities`, `classifications`, `duplicates`.
3. Validates file presence, size, and schema mapping.
4. Cleans and normalises each data source (deduplicates, renames columns, parses arrays).
5. Dynamically flattens `classifications.bson` based on namespaces defined in `config.yaml`.
6. Left-joins taxonomies onto the incident spine, guaranteeing one row per incident.
7. Exports a 5-sheet Excel workbook: **Incidents**, **Reports**, **Entities**, plus an auto-generated **Data Dictionary** and **Coverage Map**.

> **Local vs CI:** Steps 1–7 are what `main.py` does — a local run only **writes the workbook to disk**. Uploading it to Cloudflare R2 is a separate step that runs **only in GitHub Actions** (see the CI/CD section below); `main.py` never uploads.

---

## Architecture

```text
main.py  ←  entry point, orchestrates all stages
│
├── src/download.py       Scrape snapshot page, download tarball, extract BSONs, and run structural validation
├── src/schema_check.py   Key-level check — catch schema drift before heavy processing
├── src/load_data.py      Load 5 BSONs into pandas DataFrames, dynamically parsing taxonomy attributes
├── src/clean.py          Normalise each source using a Registry Pattern for specific taxonomy hooks
├── src/build_dataset.py   Left-join all taxonomies onto the incident spine sequentially
├── src/export_excel.py   Write the styled, multi-sheet Excel workbook
└── src/config.py         Typed config dataclasses + YAML loader with env overrides
```

---

## Quick Start (Local Run)

**Prerequisites:**
- Python 3.11+ (developed on 3.11; CI pins 3.11; also runs on 3.13).
- **Network access** — the first run scrapes `incidentdatabase.ai` and downloads the latest `.tar.bz2` database snapshot (tens of MB). Behind a proxy or offline, the download step will fail.

```bash
cd site/excel-export-pipeline

# (Recommended) create an isolated environment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1

# Install dependencies
pip install -r requirements.txt

# Run with default config
python main.py

# Skip schema validation (useful when snapshot schema is in flux)
python main.py --skip-schema-check

# Point to a different config file
python main.py --config path/to/config.yaml
```

Output is written to `../../output/AIID_Excel_Export.xlsx` by default. A local run **only writes this file** — it does not upload to Cloudflare R2 (that happens in CI only). Downloaded snapshots are cached under `data/snapshots/` (gitignored), so repeat runs reuse the local copy and work offline. `requirements.txt` covers the local build; the CI upload step additionally needs `boto3`, which is installed by the workflow rather than listed here.

---

## What the Output Looks Like

The **Incidents** sheet is the master table — one row per incident, with identity columns first, then one column per taxonomy attribute. A 4-of-57-column excerpt:

| Incident ID | date | title | Risk Domain (MIT) |
|---|---|---|---|
| 1 | 2015-05-19 | Google's YouTube Kids App Presents Inappropriate Content | Discrimination and Toxicity |
| 2 | 2018-12-05 | Warehouse robot ruptures can of bear spray… | AI system safety, failures, and limitations |
| 3 | 2018-10-27 | Crashes with Maneuvering Characteristics Augmentation System (MCAS) | AI system safety, failures, and limitations |

A recent run produced **1,515 incidents** (×57 columns), **7,174 reports**, and **6,444 entities**.

### Sheets in the workbook

| Sheet | What it holds |
|---|---|
| **Incidents** | The master table — one row per incident, columns grouped and color-coded by source (see groups below). The sheet opens with a dark title banner row and a merged group-category band row above the column headers. |
| **Reports** | The raw source documents (articles) linked to incidents. Kept separate because many reports map to one incident; flattening them into Incidents would explode the row count. Columns: Report Number, Title, URL, Source Domain, Date Published/Downloaded, Authors, Submitters, Language, Tags, Description, Is Incident Report. |
| **Entities** | The distinct organizations and actors tracked by the system. Columns: Entity ID, Name. |
| **Data Dictionary** | Auto-generated reference: every column in the Incidents sheet with its Column, Group, **Source**, Fill Rate (% non-empty), and a short description. |
| **Coverage Map** | Per-taxonomy-combination counts with a "What you can analyze" column describing what analysis is possible at each level, plus a TOTAL row. |

The **Incidents** sheet columns are organized into color-coded groups:

- **Identity** (dark navy) — ID, Date, Title, Description, Deployer, Developer, Harmed Parties, Editors, Editor Notes, Implicated Systems.
- **Coverage** (slate gray) — which taxonomies apply to the incident and the total report count.
- **MIT** (dark green) — Risk Domain, Risk Subdomain, Responsible Entity, Intent, Timing.
- **GMF** (brown) — AI Goal, AI Technology, Technical Failure.
- **CSETv1** (purple) — extensive harm metrics, deployment sectors, geographies, autonomy levels, AI methods, and more.

For how the raw MongoDB data is shaped and transformed into these sheets, see the [Maintenance & Developer Guide](MAINTENANCE_GUIDE.md#data-model-raw-mongodb-dump).

---

## Configuration Reference

All schemas, table definitions, and Excel formatting settings live in `config.yaml`. A small, fixed set of path/snapshot values can also be overridden via environment variables for CI/CD (see [Environment Overrides](#environment-overrides) below); everything else — taxonomies, column maps, styles, column order — is configured by editing `config.yaml`.

| Key | Default | Description |
|---|---|---|
| `paths.snapshot_dir` | `./data/snapshots` | Extracted snapshot storage path |
| `paths.output_path` | `../../output/AIID_Excel_Export.xlsx` | Final Excel output path |
| `snapshot.base_url` | `https://incidentdatabase.ai` | Root URL for resolving relative links |
| `snapshot.snapshot_page_url` | `https://incidentdatabase.ai/research/snapshots/` | Page scraped to find the latest tarball |
| `snapshot.snapshot_filter` | `.tar.bz2` | Only download links containing this string |
| `columns.*` | *(see config.yaml)* | Maps raw BSON keys to output headers for `incidents`, `reports`, `entities` |
| `columns.duplicates_id_column` | `duplicate_incident_number` | Column linking duplicates to true IDs |
| `taxonomies.*` | *(see config.yaml)* | Defines namespaces (e.g., `MIT`, `GMF`), internal mappings, and base colors |
| `styles.*` | *(see config.yaml)* | Defines Excel column header color groups (Identity, Coverage, Other) |
| `output.*_column_order` | *(see config.yaml)* | Ordered lists of columns for each sheet |

### Environment Overrides

These five environment variables are the **only** values that can be overridden without editing `config.yaml` (see `_apply_env_overrides` in `src/config.py`). The CI workflow sets `SNAPSHOT_DIR` and `OUTPUT_PATH`.

| Env var | Overrides (`config.yaml` key) |
|---|---|
| `SNAPSHOT_DIR` | `paths.snapshot_dir` |
| `OUTPUT_PATH` | `paths.output_path` |
| `SNAPSHOT_PAGE_URL` | `snapshot.snapshot_page_url` |
| `BASE_URL` | `snapshot.base_url` |
| `SNAPSHOT_FILTER` | `snapshot.snapshot_filter` |

Taxonomies, column maps, styles, and column order are **not** env-overridable — edit `config.yaml` for those.

---

## CI/CD (GitHub Actions)

**Workflow file:** `.github/workflows/excel-export-pipeline.yml`

**Triggers:**
- **Scheduled:** Every Monday at 10:00 AM UTC
- **Manual:** `workflow_dispatch` with an `environment` input (defaults to `production`)

**Process:**
1. Checkout repo and set up Python 3.11.
2. Install dependencies.
3. Run `main.py` (with overridden `SNAPSHOT_DIR` and `OUTPUT_PATH`).
4. Validate output file exists.
5. Upload to Cloudflare R2 as `AIID_Excel_Export-YYYYMMDD.xlsx`.

**Required configuration** (set on the GitHub environment chosen by the `environment` input):

| Name | Type | Purpose |
|---|---|---|
| `CLOUDFLARE_R2_ACCOUNT_ID` | variable | R2 account ID |
| `CLOUDFLARE_R2_BUCKET_NAME` | variable | Target R2 bucket |
| `CLOUDFLARE_R2_WRITE_ACCESS_KEY_ID` | secret | R2 access key (write) |
| `CLOUDFLARE_R2_WRITE_SECRET_ACCESS_KEY` | secret | R2 secret key (write) |

Only the final upload step needs these; the build itself runs without any credentials.

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success — Excel file written |
| `1`* | Uncaught exception — missing/0-byte file, network failure, etc. |
| `2` | Schema check failed — missing mapped columns in upstream BSONs |

\* `main.py` only ever *returns* `0` or `2` deliberately; any other failure surfaces as a non-zero exit (typically `1`) from an uncaught Python exception, so don't write CI logic that depends on a guaranteed `1`.

---

## Contributing & License

This pipeline is part of the [AI Incident Database](../../README.md), an open-source project — contributions are welcome.

- **Contributing:** follow the project's [contribution workflow](../../README.md#contributing-changes) (fork → feature branch → PR). To extend the pipeline itself (new columns, taxonomies, cleaning hooks), start with the [Maintenance & Developer Guide](MAINTENANCE_GUIDE.md).
- **Code of Conduct:** all participants are expected to follow the project [Code of Conduct](../../CODE_OF_CONDUCT.md).
- **License:** released under the project [LICENSE](../../LICENSE.txt).
