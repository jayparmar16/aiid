# Excel Export Pipeline + Snapshot Page Redesign

## What this PR does

Replaces the old `master-db-pipeline` with a new config-driven ETL pipeline (`site/excel-export-pipeline/`) that produces a styled multi-sheet Excel workbook from the latest AIID snapshot. Also redesigns the `/research/snapshots` page to surface the workbook alongside snapshot downloads.

---

## Key changes

### New pipeline — `site/excel-export-pipeline/`

A weekly GitHub Actions workflow downloads the latest AIID snapshot, processes it through a staged Python pipeline, and uploads the resulting workbook to Cloudflare R2.

All column mappings, taxonomy namespaces, colours, and output paths live in `config.yaml` — no Python changes needed to add a column or taxonomy.

Pipeline stages:

1. **Download** — fetches and extracts the latest `.tar.bz2` snapshot
2. **Schema check** — validates YAML-mapped columns still exist upstream; exits `2` on drift
3. **Load** — reads BSON into DataFrames, flattens taxonomy `attributes` arrays
4. **Clean** — standardises dates, deduplicates, parses JSON-array strings
5. **Join** — left-joins MIT / GMF / CSETv1 onto the incident spine; populates `Data Sources`
6. **Export** — writes the styled multi-sheet workbook

### Excel workbook — 5 sheets

| Sheet | Description |
|---|---|
| **Incidents** | One row per incident. Dark title banner + merged group-category band row + group-coloured headers. Freeze at C4. |
| **Reports** | Source articles linked to incidents. Banner + navy header + zebra rows. |
| **Entities** | Organisations and actors. Same styling as Reports. |
| **Data Dictionary** | Every Incidents column with Group, Source, Fill Rate, and Description. |
| **Coverage Map** | Per-taxonomy-combination counts with a "What you can analyze" column and a TOTAL row. |

Colour palette matches `AIID_Master_Dataset-20260513.xlsx`: Identity `#1F3864`, Coverage `#2E4057`, MIT `#1A6B3C`, GMF `#7B3F00`, CSETv1 `#4A235A`.

Group band labels are driven by an optional `band_label` key in `config.yaml` — defaults to the group name if absent.

### Annotated-db-pipeline cleanup

- Renamed `master-db-pipeline` → `annotated-db-pipeline` throughout (workflow, modules, config keys)
- Removed stale `build_master.py` and the old GitHub Actions workflow
- `.gitignore` updated to exclude local `data/` and `output/`

### Snapshot page

- Two-column layout: snapshot downloads (left), Excel export (right)
- `createBackupsPage.js` separates Excel exports from database backups
- `backups.js` shows build date, file size, and download link

---

## How to verify

```bash
cd site/excel-export-pipeline

# 1. Compile check
python -m py_compile main.py src/*.py

# 2. End-to-end run (uses cached snapshot — no network needed after first run)
python main.py
# Expected: exit 0, "Excel written to …/output/AIID_Excel_Export.xlsx"

# 3. Assert structure and styling
python - <<'PY'
import openpyxl
from openpyxl.utils import get_column_letter
wb = openpyxl.load_workbook("../../output/AIID_Excel_Export.xlsx")
assert wb.sheetnames == ["Incidents","Reports","Entities","Data Dictionary","Coverage Map"]
ws = wb["Incidents"]
n = ws.max_column
assert ws["A1"].fill.fgColor.rgb.endswith("0D1B2A")          # banner colour
assert ws["A3"].fill.fgColor.rgb.endswith("1F3864")           # Identity header
assert ws.cell(3, next(c for c in range(1,n+1) if ws.cell(3,c).value == "Risk Domain")).fill.fgColor.rgb.endswith("1A6B3C")  # MIT header
assert ws.freeze_panes == "C4"
assert ws.cell(4,1).fill.fgColor.rgb.endswith("FFFFFF")       # row 1 white
assert ws.cell(5,1).fill.fgColor.rgb.endswith("F5F5F5")       # row 2 stripe
dd = wb["Data Dictionary"]
assert [dd.cell(2,i).value for i in range(1,6)] == ["Column","Group","Source","Fill Rate","Description"]
cm = wb["Coverage Map"]
assert cm.cell(cm.max_row,1).value == "TOTAL"
print("OK")
PY
```

Pass = prints `OK`.
