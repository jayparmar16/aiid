# Pipeline Maintenance Guide

This pipeline utilizes a **Metadata-Driven Architecture**. Configuration rules for data extraction, flattening, and Excel formatting are defined entirely in `config.yaml`. Avoid modifying Python code for routine schema updates or aesthetic changes.

> **Related docs:** [README](README.md) — overview, how to run, CI/CD, and the output workbook's sheets/columns.

---

## Data Model (raw MongoDB dump)

The pipeline starts from a `.tar.bz2` snapshot of the production database — a set of BSON files, one
per collection. The `config.yaml` mappings (below) map *from* the raw keys described here.

### Core collections

- **`incidents.bson` (the spine)** — one document per unique AI incident (~1,500 records). Core
  identity fields (`incident_id`, `title`, `description`, `date`), lists of involved parties
  (`Alleged deployer of AI system`, `Alleged developer of AI system`,
  `Alleged harmed or nearly harmed parties`), plus metadata: NLP similarity scores, TSNE coordinates,
  embeddings, editors, and arrays mapping the incident to its reports.
- **`reports.bson` (the sources)** — one document per source article (~7,100 records):
  `report_number`, `title`, `url`, `source_domain`, publication dates, authors, submitters, the full
  scraped `text`, and `tags`. Many-to-one with incidents.
- **`entities.bson` (the actors)** — one document per recognized entity — companies, organizations,
  individuals (~6,300 records): `entity_id`, `name`, modification timestamps.
- **`duplicates.bson` (dedup mapping)** — key-value pairs mapping a `duplicate_incident_number` to its
  `true_incident_number`, used to filter deprecated incident IDs out of the final dataset.

### The taxonomies collection

- **`classifications.bson` (the annotations)** — each document is a set of classifications applied to
  an incident (or report) under a specific **namespace** (taxonomy). Values are not flat columns:
  they are stored as an array of `attributes`, each with a `short_name` (field name) and `value_json`
  (the value). Namespaces:
  - **MIT** — Risk Domains, Risk Subdomains, Responsible Entities, Intent, Timing.
  - **GMF** — AI Goal, AI Technology, Technical Failure.
  - **CSETv1** — a highly detailed framework: Harm Domains, Tangible Harms, AI Harm Levels, Rights
    Violations, Locations, Infrastructure Sectors, Autonomy Levels, AI Methods, and more.

---

## 1. Configuration (`config.yaml`)

- **`columns`**: Maps raw BSON keys to Excel headers for core collections (Incidents, Reports, Entities).
- **`taxonomies`**: Maps nested BSON classification attributes to flat columns based on taxonomy namespaces (e.g., MIT, GMF).
- **`styles`**: Controls Excel formatting (hex colors, column groups, optional `band_label`) independent of Python logic. Each group may include a `band_label` key shown in the merged group-category band row above headers; if omitted, the group name is used as the fallback label.
- **`output`**: Enforces strict left-to-right column order in exported Excel sheets.

---

## 2. Pipeline Execution Steps

1. **Download (`download.py`)**: Fetches the latest MongoDB `.tar.bz2` dump, extracts files, and validates structural integrity (0-byte checks).
2. **Schema Check (`schema_check.py`)**: Header-level check that the columns mapped in `config.yaml` still exist in the upstream BSONs, catching schema drift before any heavy processing (exits with code `2` on a mismatch; bypass with `--skip-schema-check`).
3. **Load (`load_data.py`)**: Reads BSON files into Pandas DataFrames and dynamically flattens the classifications based on `taxonomies` defined in the YAML — filters by namespace (MIT, GMF, CSETv1) and pivots each document's `attributes` array so every `short_name` becomes a standard column.
4. **Clean (`clean.py`)**: Formats dates into standardized formats, purges incident IDs found in `duplicates.bson` from all datasets (preventing ghost records), parses JSON-like string arrays into readable strings (e.g. `["navya", "keolis"]` → `"Navya, Keolis"`), and strips numeric prefixes from MIT labels (e.g. `"1. Physical Safety"` → `"Physical Safety"`).
5. **Join (`build_dataset.py`)**: Takes the cleaned Incidents DataFrame as the spine and left-joins the flattened MIT, GMF, and CSETv1 tables on `Incident ID`. Every incident gets exactly **one row**; an incident lacking a taxonomy classification simply has blank (`NaN`) cells for it. Populates the "Data Sources" column based on which joins matched.
6. **Export (`export_excel.py`)**: Applies `config.yaml` styling and writes the multi-sheet Excel workbook.

---

## 3. Routine Operations

### Add a New Incident Column
1. Open `config.yaml`.
2. Add mapping to `columns.incidents` (e.g., `new_field: New Header`).
3. Add `New Header` to `output.column_order`.
4. Add `New Header` to the desired block in `styles` (e.g., `styles.Identity.columns`). Optionally update `styles.Identity.band_label` if the group label should change.

### Add a New Taxonomy (e.g., EU AI Act)
1. Open `config.yaml`.
2. Add a new block under `taxonomies:`
   ```yaml
   EU_AI_ACT:
     color: "1ABC9C"
     band_label: "REGULATORY DETAIL - EU AI Act"   # optional; defaults to "EU_AI_ACT"
     mapping:
       Incident ID: Incident ID
       Risk Category: EU Risk Category
   ```
3. Add the mapped output columns (e.g., `EU Risk Category`) to `output.column_order`.

### Implement Custom Taxonomy Cleaning
If a taxonomy requires custom formatting beyond basic column renaming (e.g., converting a numeric month string to a text string):
1. Open `src/clean.py`.
2. Create a custom hook:
   ```python
   def hook_clean_eu_ai_act(df: pd.DataFrame) -> pd.DataFrame:
       # Custom formatting logic
       return df
   ```
3. Register the hook in the `CLEANING_HOOKS` mapping:
   ```python
   CLEANING_HOOKS = {
       "EU_AI_ACT": hook_clean_eu_ai_act,
   }
   ```

---
### Handle Upstream Schema Changes

`config.yaml` mappings follow the pattern `bson_field_name: Output Column Name`. The **left side
(key) is what the BSON contains**; the **right side (value) is what appears in the Excel output**.
Keep this distinction in mind for every scenario below.

#### A field was renamed in `incidents.bson`, `reports.bson`, or `entities.bson`

The schema check will exit with code `2`, reporting the old name as missing and the new name as a
new column. Fix: update only the **key** in `config.yaml` to match the new BSON field name. The
value (output column name) stays the same, so nothing else in the pipeline needs to change.

```yaml
# Before
columns:
  incidents:
    incident_id: Incident ID

# After (BSON renamed incident_id -> incidentId)
columns:
  incidents:
    incidentId: Incident ID
```

#### A `short_name` was renamed inside `classifications.bson`

Taxonomy attributes are stored as an array of `{short_name, value_json}` pairs. The `short_name`
is the key in the `taxonomies.*.mapping` block. Update it the same way — change only the key,
keep the value.

```yaml
# Before
taxonomies:
  GMF:
    mapping:
      Known AI Goal: AI Goal

# After (short_name changed upstream to AI_Goal)
taxonomies:
  GMF:
    mapping:
      AI_Goal: AI Goal
```

#### A new field appeared in a core BSON collection

New fields are silently dropped — the pipeline only keeps columns present in the mapping. The
schema check will print a notice but will not fail. To include the new field in the output:

1. Add the mapping to the relevant section (`columns.incidents`, `columns.reports`, or
   `columns.entities`).
2. Add the output column name to the matching `output.*_column_order` list in the position you
   want. Columns not listed there appear after all listed columns.
3. Optionally add the output name to a group under `styles` for header colouring.

#### A new attribute appeared in a taxonomy namespace

Same as above: silently dropped unless added to `taxonomies.*.mapping`. Add it there, then add the
output name to `output.column_order`.


## 4. Testing / Validating Your Changes

There is no automated test suite — run the pipeline end-to-end to validate changes:

1. Run it: `python main.py` (add `--skip-schema-check` while iterating on snapshots whose schema is in flux).
2. A clean run exits `0` and prints `Excel written to …/output/AIID_Excel_Export.xlsx` followed by the row counts.
3. Open `output/AIID_Excel_Export.xlsx` and confirm all five sheets are present: **Incidents, Reports, Entities, Data Dictionary, Coverage Map**.
4. Sanity-check the row counts against the current database (recent run: ~1,496 incidents, ~7,143 reports, ~6,380 entities). Large, unexplained drops usually signal a join or cleaning regression.
5. Treat the exit code as the verdict — `2` = schema check failed (see [Exit Codes](README.md#exit-codes) and Troubleshooting below).

---

## 5. Troubleshooting

- **`Schema check failed. Missing columns:`**
  A mapped key was not found in the upstream BSON. Either the field was renamed or dropped. If
  renamed, update the key (left side) in `config.yaml` to the new field name — see
  [Handle Upstream Schema Changes](#handle-upstream-schema-changes). If dropped, remove that key
  from `config.yaml` entirely.
  
- **`ValueError: The file ... is 0 bytes`**
  The backup archive is corrupted or the database export failed upstream. Verify the snapshot hosted on Cloudflare R2.