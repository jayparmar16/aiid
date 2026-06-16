from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List
import os
import yaml


@dataclass
class PathsConfig:
    """Filesystem locations for inputs/outputs."""

    snapshot_dir: Path
    output_path: Path


@dataclass
class SnapshotConfig:
    """Settings for discovering and downloading public snapshot archives."""

    base_url: str
    snapshot_page_url: str
    snapshot_filter: str


@dataclass
class ColumnsConfig:
    """Column mapping config for core collections (raw column -> normalized output column)."""

    incidents: Dict[str, str]
    reports: Dict[str, str]
    entities: Dict[str, str]
    duplicates_id_column: str


@dataclass
class TaxonomyConfig:
    """Config for an individual taxonomy namespace."""

    color: str
    band_label: str
    mapping: Dict[str, str]


@dataclass
class OutputConfig:
    """Excel output shape preferences."""

    column_order: List[str]
    reports_column_order: List[str]
    entities_column_order: List[str]


@dataclass
class StyleConfig:
    """Config for an Excel column style group."""

    color: str
    band_label: str
    columns: List[str]

@dataclass
class PipelineConfig:
    """Top-level configuration for the Excel export build pipeline."""

    paths: PathsConfig
    snapshot: SnapshotConfig
    columns: ColumnsConfig
    taxonomies: Dict[str, TaxonomyConfig]
    styles: Dict[str, StyleConfig]
    output: OutputConfig


def _apply_env_overrides(raw: dict) -> dict:
    """Override YAML config with environment variables"""
    paths = raw.setdefault("paths", {})
    snapshot = raw.setdefault("snapshot", {})

    # Paths
    if os.getenv("SNAPSHOT_DIR"):
        paths["snapshot_dir"] = os.getenv("SNAPSHOT_DIR")
    if os.getenv("OUTPUT_PATH"):
        paths["output_path"] = os.getenv("OUTPUT_PATH")

    # Snapshot discovery
    if os.getenv("SNAPSHOT_PAGE_URL"):
        snapshot["snapshot_page_url"] = os.getenv("SNAPSHOT_PAGE_URL")
    if os.getenv("BASE_URL"):
        snapshot["base_url"] = os.getenv("BASE_URL")
    if os.getenv("SNAPSHOT_FILTER"):
        snapshot["snapshot_filter"] = os.getenv("SNAPSHOT_FILTER")

    return raw


def load_config(path: Path) -> PipelineConfig:
    """Load config YAML from disk and return a typed PipelineConfig."""
    with open(path, "r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle)

    # Allow CI/manual overrides without editing the repo config.yaml.
    raw = _apply_env_overrides(raw)

    paths = PathsConfig(
        snapshot_dir=Path(raw["paths"]["snapshot_dir"]).resolve(),
        output_path=Path(raw["paths"]["output_path"]).resolve(),
    )
    snapshot = SnapshotConfig(
        base_url=raw["snapshot"]["base_url"],
        snapshot_page_url=raw["snapshot"]["snapshot_page_url"],
        snapshot_filter=raw["snapshot"]["snapshot_filter"],
    )
    columns = ColumnsConfig(
        incidents=raw["columns"]["incidents"],
        reports=raw["columns"].get("reports", {}),
        entities=raw["columns"].get("entities", {}),
        duplicates_id_column=raw["columns"]["duplicates_id_column"],
    )
    
    taxonomies = {}
    for name, tax_raw in raw.get("taxonomies", {}).items():
        taxonomies[name] = TaxonomyConfig(
            color=tax_raw["color"],
            band_label=tax_raw.get("band_label", name),
            mapping=tax_raw["mapping"]
        )
        
    styles = {}
    for name, style_raw in raw.get("styles", {}).items():
        styles[name] = StyleConfig(
            color=style_raw["color"],
            band_label=style_raw.get("band_label", name),
            columns=list(style_raw.get("columns", []))
        )
    
    output = OutputConfig(
        column_order=list(raw["output"]["column_order"]),
        reports_column_order=list(raw["output"].get("reports_column_order", [])),
        entities_column_order=list(raw["output"].get("entities_column_order", [])),
    )

    return PipelineConfig(
        paths=paths,
        snapshot=snapshot,
        columns=columns,
        taxonomies=taxonomies,
        styles=styles,
        output=output,
    )
