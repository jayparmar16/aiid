# AIID Annotated Dataset Pipeline

Builds the **AI Incident Database Annotated Dataset** — a styled Excel workbook that joins every incident record with its taxonomy classifications (MIT, GMF, CSETv1). Runs weekly via GitHub Actions and uploads the result to Cloudflare R2.

---

## What This Does

1. Downloads the latest public AIID database snapshot (`.tar.bz2`) from `incidentdatabase.ai`
2. Extracts five CSVs: incidents, MIT taxonomy, GMF taxonomy, CSETv1 taxonomy, and duplicates
3. Validates CSV headers against expected column mappings
4. Cleans and normalises each source (deduplicates, renames columns, parses entity lists)
5. Left-joins all taxonomies onto the incident spine — **one row per incident, always**
6. Validates coverage and data quality against configurable thresholds
7. Exports a three-sheet Excel workbook and uploads it to Cloudflare R2

---

## Architecture

```
main.py  ←  entry point, orchestrates all stages
│
├── src/download.py       Scrape snapshot page, download tarball, extract CSVs
├── src/schema_check.py   Header-only check — catch schema drift before heavy work
├── src/load_data.py      Load all 5 CSVs into pandas DataFrames
├── src/clean.py          Normalise each source (rename, filter duplicates, parse lists)
├── src/build_master.py   Left-join taxonomies onto incident spine
├── src/validate.py       Data quality guardrails (hard errors + soft warnings)
├── src/export_excel.py   Write styled 3-sheet Excel workbook
└── src/config.py         Typed config dataclasses + YAML loader with env overrides
```

---

## Quick Start (Local Run)

**Prerequisites:** Python 3.11+

```bash
cd site/annotated-db-pipeline

# Install dependencies
pip install -r requirements.txt

# Run with default config
python main.py

# Skip header schema validation (useful when snapshot schema is in flux)
python main.py --skip-schema-check

# Point to a different config file
python main.py --config path/to/config.yaml
```

Output is written to `output/AIID_Annotated_Dataset.xlsx` by default.

---

## Configuration Reference

All settings live in `config.yaml`. Every value can be overridden via environment variable (see next section).

| Key | Default | Description |
|---|---|---|
| `paths.snapshot_dir` | `./data/snapshots` | Where downloaded/extracted snapshot files are stored |
| `paths.output_path` | `./output/AIID_Annotated_Dataset.xlsx` | Final Excel output path |
| `snapshot.base_url` | `https://incidentdatabase.ai` | Root URL for resolving relative snapshot links |
| `snapshot.snapshot_page_url` | `https://incidentdatabase.ai/research/snapshots/` | Page scraped to find the latest tarball |
| `snapshot.snapshot_filter` | `.tar.bz2` | Only download links containing this string |
| `columns.incidents` | *(see config.yaml)* | Maps raw CSV column names → normalised output names for incidents |
| `columns.mit` | *(see config.yaml)* | Column mapping for MIT taxonomy |
| `columns.gmf` | *(see config.yaml)* | Column mapping for GMF taxonomy |
| `columns.cset` | *(see config.yaml)* | Column mapping for CSETv1 taxonomy |
| `columns.duplicates_id_column` | `duplicate_incident_number` | Column in duplicates CSV holding the incident ID to exclude |
| `validation.expected_min_incidents` | `1300` | Hard minimum row count — pipeline fails if below this |
| `validation.expected_mit_coverage` | `85.0` | Soft warning threshold: % of incidents with MIT classification |
| `output.master_column_order` | *(see config.yaml)* | Ordered list of columns in the output Excel sheet |

---

## Environment Variable Overrides

These override config.yaml values without editing the file — designed for CI use.

| Variable | Overrides |
|---|---|
| `SNAPSHOT_DIR` | `paths.snapshot_dir` |
| `OUTPUT_PATH` | `paths.output_path` |
| `SNAPSHOT_PAGE_URL` | `snapshot.snapshot_page_url` |
| `BASE_URL` | `snapshot.base_url` |
| `SNAPSHOT_FILTER` | `snapshot.snapshot_filter` |
| `EXPECTED_MIN_INCIDENTS` | `validation.expected_min_incidents` |
| `EXPECTED_MIT_COVERAGE` | `validation.expected_mit_coverage` |

---

## Pipeline Stages

### 1. `src/download.py` — Snapshot Discovery & Extraction

Scrapes the public snapshots page, picks the latest `.tar.bz2` link by filename timestamp, streams it to disk, and extracts the archive. Locates exactly five required CSVs via glob and returns their absolute paths.

**Key function:** `download_and_extract(config) → SnapshotPaths`

---

### 2. `src/schema_check.py` — Header Validation

Reads only the headers of each CSV (zero data rows loaded) and compares them against the column mappings in `config.yaml`. Reports missing expected columns as errors and new unmapped columns as informational warnings.

**Key function:** `check_schema(config, paths) → SchemaCheckResult`

> **Tip:** If the upstream snapshot adds or renames columns, this stage catches it before any data processing. Use `--skip-schema-check` to bypass during transitions while you update the mappings.

---

### 3. `src/load_data.py` — CSV Loading

Loads all five CSVs into pandas DataFrames with `low_memory=False` to avoid mixed-type inference warnings on large files.

**Key function:** `load_raw_data(paths) → RawData`

---

### 4. `src/clean.py` — Normalisation

Cleans each source independently:

| Function | What it does |
|---|---|
| `clean_incidents` | Keeps mapped columns, renames them, removes duplicates, parses JSON entity lists, counts reports, derives `year` |
| `clean_mit` | Strips numeric prefixes from Risk Domain/Subdomain (e.g. `"1. Physical Safety"` → `"Physical Safety"`) |
| `clean_gmf` | Renames columns, filters duplicates |
| `clean_cset` | Keeps first row per incident (CSET can have multiple), normalises location cities, converts month numbers to names |
| `compute_duplicate_ids` | Returns a set of incident IDs to exclude across all sources |

---

### 5. `src/build_master.py` — Dataset Assembly

Left-joins MIT, GMF, and CSETv1 onto the incident spine in sequence. A left-join means:

- Every incident appears exactly once
- Incidents without a taxonomy classification get `NaN` for those columns
- No new rows are ever introduced

Also adds a **Data Sources** column showing which taxonomies classified each incident (e.g. `"MIT | GMF | CSETv1"`).

**Key function:** `build_master(inc, mit, gmf, cset, config) → DataFrame`

---

### 6. `src/validate.py` — Data Quality Guardrails

Runs checks after the join and stops the pipeline (exit code 3) if any hard check fails.

| Check | Type | Description |
|---|---|---|
| Minimum row count | Hard error | Total incidents ≥ `expected_min_incidents` |
| No duplicate incident IDs | Hard error | Each Incident ID appears exactly once |
| Core columns non-null | Hard error | 10 identity columns have 0 null values |
| Row count unchanged | Hard error | Join produced same count as incident spine |
| MIT coverage | Warning | % classified by MIT ≥ `expected_mit_coverage` |
| Year range | Warning | Years span ≥ 1980 and include ≥ 2024 |

---

### 7. `src/export_excel.py` — Excel Export

Creates a workbook with three sheets:

| Sheet | Contents |
|---|---|
| **Annotated Dataset** | All incident data with colour-coded column group headers, frozen panes, auto-filter |
| **Data Dictionary** | Every column with its group, source file, fill rate %, and description |
| **Coverage Map** | Breakdown of which taxonomy combinations are present and what you can analyse with each |

Columns are colour-coded by group:

| Group | Colour | Columns |
|---|---|---|
| Identity | Dark navy | Incident ID, date, year, title, description, deployer, developer, harmed |
| Coverage | Slate | Data Sources, report_count |
| MIT | Dark green | Risk Domain, Risk Subdomain, Responsible Entity, Intent, Timing |
| GMF | Brown | AI Goal, AI Technology, Technical Failure |
| CSETv1 | Purple | Harm Domain, Tangible Harm, AI Harm Level, sector/geography/harm fields |

---

## CI/CD (GitHub Actions)

**Workflow file:** `.github/workflows/annotated-db-pipeline.yml`

**Triggers:**
- **Scheduled:** Every Monday at 10:00 AM UTC
- **Manual:** `workflow_dispatch` with an `environment` input (defaults to `production`)

**What it does:**

```
1. Checkout repo
2. Set up Python 3.11
3. pip install requirements + boto3
4. Run main.py  (SNAPSHOT_DIR and OUTPUT_PATH set to workspace artifact paths)
5. Validate output file exists and is non-empty
6. Upload to Cloudflare R2 as AIID_Annotated_Dataset-YYYYMMDD.xlsx
```

**Required GitHub secrets/vars** (under the environment configured at dispatch):

| Name | Type | Used for |
|---|---|---|
| `CLOUDFLARE_R2_ACCOUNT_ID` | var | R2 endpoint construction |
| `CLOUDFLARE_R2_WRITE_ACCESS_KEY_ID` | secret | R2 authentication |
| `CLOUDFLARE_R2_WRITE_SECRET_ACCESS_KEY` | secret | R2 authentication |
| `CLOUDFLARE_R2_BUCKET_NAME` | var | Target R2 bucket |

---

## How to Maintain / Extend

### Upstream column changed or renamed

1. Run `python main.py` — the schema check will print the missing/new columns
2. Update the relevant section under `columns:` in `config.yaml`
3. If the column order in Excel should change, update `output.master_column_order`
4. Use `--skip-schema-check` while iterating to bypass the guard

### Add a new taxonomy source

1. Add its CSV to the snapshot extraction glob in `src/download.py`
2. Add its column mapping under `columns:` in `config.yaml`
3. Add a `clean_<source>()` function in `src/clean.py`
4. Add its left-join in `src/build_master.py`
5. Add column descriptions to `_write_dictionary_sheet()` in `src/export_excel.py`
6. Add a colour group in `_col_group()` in `src/export_excel.py`

### Change validation thresholds

Edit `config.yaml` directly or set `EXPECTED_MIN_INCIDENTS` / `EXPECTED_MIT_COVERAGE` environment variables. No code changes needed.

### Run against a different snapshot version

Set `SNAPSHOT_PAGE_URL` to point at a different page, or manually place extracted CSVs in `data/snapshots/` and set `SNAPSHOT_DIR` to skip the download step.

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success — Excel file written |
| `2` | Schema check failed — missing expected columns in upstream CSVs |
| `3` | Validation failed — data quality guardrail triggered |
