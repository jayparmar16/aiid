## Summary

Adds an automated pipeline that produces a downloadable Excel export of the full AIID dataset and updates the `/research/snapshots` page to surface it.

## Why

Researchers, journalists, and analysts who want to explore the database often do not want to write GraphQL queries or work with raw MongoDB dumps. A single Excel file with incidents, reports, entities, and taxonomy classifications joined together covers that use case without any API or database knowledge required.

## What changed

### New: `site/excel-export-pipeline/`

A Python pipeline with 6 modules, each mapping to a documented maintenance step:

| Module | What it does |
|---|---|
| `download.py` | Scrapes the snapshots page, downloads the latest `.tar.bz2`, extracts BSONs |
| `schema_check.py` | Validates expected columns are present before processing starts |
| `load_data.py` | Loads 5 BSON collections into DataFrames, flattens taxonomy attributes |
| `clean.py` | Normalises each source; taxonomy-specific hooks registered in `CLEANING_HOOKS` |
| `build_dataset.py` | Left-joins all taxonomies onto the incident spine (one row per incident) |
| `export_excel.py` | Writes a styled 5-sheet workbook |

Output: **5 sheets** -- Incidents, Reports, Entities, Data Dictionary, Coverage Map.

Config is YAML-driven (`config.yaml`). Column mappings, taxonomy namespaces, style groups, and output paths are all configurable without touching code. See [`MAINTENANCE_GUIDE.md`](site/excel-export-pipeline/MAINTENANCE_GUIDE.md) for how to add columns, taxonomies, or cleaning hooks.

### New: GitHub Actions workflow

`.github/workflows/excel-export-pipeline.yml` runs every Monday at 10:00 UTC and on manual dispatch. It builds the workbook and uploads it to Cloudflare R2 as `AIID_Excel_Export-YYYYMMDD.xlsx`.

Required repository secrets:
- `CLOUDFLARE_R2_ACCOUNT_ID`
- `CLOUDFLARE_R2_WRITE_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_WRITE_SECRET_ACCESS_KEY`
- `CLOUDFLARE_R2_BUCKET_NAME`

### Updated: `/research/snapshots` page

- Two-column layout: snapshot downloads on the left, Excel export on the right. Stacks vertically on mobile.
- `createBackupsPage.js` now always renders (with an empty state) even when R2 is unreachable, and separates Excel exports (`AIID_Excel_Export-*.xlsx`) from database backups (`backup-*`).
- `backups.js` shows build date, file size, and download link for each export.

### Updated: `site/db-backup/bin/cloudflare_operations.py`

Added an optional `--content_type` CLI argument (default: `application/x-bzip2`). Excel uploads require `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

### Removed: `site/annotated-db-pipeline/`

Superseded by `excel-export-pipeline`. All content has been moved or rewritten.

## How to test locally

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1
pip install -r site/excel-export-pipeline/requirements.txt
python site/excel-export-pipeline/main.py
# Output written to: output/AIID_Excel_Export.xlsx
```

The pipeline downloads the latest public snapshot on first run and caches it locally under `snapshot_dir` (set in `config.yaml`). Subsequent runs reuse the cached archive.

## Example output

An example workbook from a recent CI run is available [here](https://github.com/jayparmar16/aiid/actions/runs/24663527799/artifacts/6530236159).
