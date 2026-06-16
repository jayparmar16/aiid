from __future__ import annotations

import pandas as pd
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet
from typing import Callable

from .config import PipelineConfig

def _col_group(col: str, config: PipelineConfig) -> tuple[str, str]:
    """Return the grouping name and hex colour for a given column based on config."""
    
    # 1. Check if it's in the explicit styles list
    for style_name, style_conf in config.styles.items():
        if col in style_conf.columns:
            return (style_name, style_conf.color)

    # 2. Check if it belongs to a taxonomy mapping
    for tax_name, tax_config in config.taxonomies.items():
        if col in tax_config.mapping.values():
            return (tax_name, tax_config.color)
            
    return ("Other", "95A5A6")


def _style_headers(
    ws: Worksheet,
    width: Callable[[str], int],
    color: Callable[[str], str] | None = None,
    freeze: str | None = None,
) -> None:
    """Bold the header row, optionally fill each header, set widths, and freeze/filter."""
    if freeze:
        ws.freeze_panes = freeze
        ws.auto_filter.ref = ws.dimensions
    for col_idx in range(1, ws.max_column + 1):
        cell = ws.cell(row=1, column=col_idx)
        col_name = str(cell.value)
        if color:
            cell.font = Font(bold=True, color="FFFFFF")
            hex_col = color(col_name)
            cell.fill = PatternFill(start_color=hex_col, end_color=hex_col, fill_type="solid")
        else:
            cell.font = Font(bold=True)
        ws.column_dimensions[get_column_letter(col_idx)].width = width(col_name)


def _apply_order(df: pd.DataFrame, preferred: list[str]) -> pd.DataFrame:
    """Reorder columns: preferred order first, then any remaining columns."""
    order = [c for c in preferred if c in df.columns]
    order += [c for c in df.columns if c not in order]
    return df[order]


def _format_data_sheet(ws: Worksheet, config: PipelineConfig) -> None:
    """Format the primary data sheet with frozen panes and colour-coded headers."""
    _style_headers(
        ws,
        width=lambda c: 50 if c in ("title", "description", "AI System Description") else 20,
        color=lambda c: _col_group(c, config)[1],
        freeze="B2",
    )

def _format_generic_sheet(ws: Worksheet) -> None:
    """Format generic data sheets like Reports and Entities."""
    _style_headers(
        ws,
        width=lambda c: 50 if c.lower() in ("description", "title", "url", "text") else 20,
        color=lambda c: "2C3E50",
        freeze="A2",
    )

def _write_dictionary_sheet(df: pd.DataFrame, writer: pd.ExcelWriter, config: PipelineConfig) -> None:
    """Generate and write the data dictionary sheet."""
    dict_data = []
    total_rows = len(df)

    # Simplified descriptions for the example.
    descriptions = {
        "Incident ID": "Unique identifier for the incident",
        "date": "Date the incident occurred",
        "title": "Title of the incident",
        "Data Sources": "Which taxonomies have classified this incident",
    }

    for col in df.columns:
        group_name, _ = _col_group(col, config)
        non_null = df[col].count()
        fill_rate = f"{(non_null / total_rows * 100):.1f}%" if total_rows > 0 else "0%"

        dict_data.append(
            {
                "Column Name": col,
                "Group": group_name,
                "Fill Rate": fill_rate,
                "Description": descriptions.get(col, ""),
            }
        )

    dict_df = pd.DataFrame(dict_data)
    dict_df.to_excel(writer, sheet_name="Data Dictionary", index=False)

    ws = writer.sheets["Data Dictionary"]
    _style_headers(ws, width=lambda c: 25, color=lambda c: "34495E", freeze="A2")
    ws.column_dimensions["D"].width = 60  # widen Description column


def _write_coverage_map(df: pd.DataFrame, writer: pd.ExcelWriter) -> None:
    """Generate and write a summary sheet showing classification overlap."""
    if "Data Sources" not in df.columns:
        return

    coverage = df["Data Sources"].value_counts().reset_index()
    coverage.columns = pd.Index(["Taxonomy Combination", "Incident Count"])

    # Calculate percentage
    total = coverage["Incident Count"].sum()
    coverage["% of Database"] = (coverage["Incident Count"] / total * 100).round(1).astype(str) + "%"

    coverage.to_excel(writer, sheet_name="Coverage Map", index=False)

    ws = writer.sheets["Coverage Map"]
    _style_headers(ws, width=lambda c: 30)


def export_excel(df: pd.DataFrame, reports: pd.DataFrame, entities: pd.DataFrame, config: PipelineConfig) -> None:
    """Write the Excel export workbook with multiple sheets."""
    output_path = config.paths.output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    df = _apply_order(df, config.output.column_order)
    reports = _apply_order(reports, config.output.reports_column_order)
    entities = _apply_order(entities, config.output.entities_column_order)

    # Clean timezone data if any timestamps are tz-aware (Excel doesn't support them directly).
    for d in [df, reports, entities]:
        for col in d.select_dtypes(include=["datetime64[ns, UTC]"]).columns:
            d[col] = d[col].dt.tz_localize(None)

    with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Incidents", index=False)
        _format_data_sheet(writer.sheets["Incidents"], config)
        
        reports.to_excel(writer, sheet_name="Reports", index=False)
        _format_generic_sheet(writer.sheets["Reports"])
        
        entities.to_excel(writer, sheet_name="Entities", index=False)
        _format_generic_sheet(writer.sheets["Entities"])

        _write_dictionary_sheet(df, writer, config)
        _write_coverage_map(df, writer)
