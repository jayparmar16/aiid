from __future__ import annotations

from dataclasses import dataclass
import pandas as pd
import json
import bson
from pathlib import Path

from .download import SnapshotPaths
from .config import PipelineConfig

@dataclass
class RawData:
    """Raw DataFrames loaded from the extracted snapshot dump."""

    incidents: pd.DataFrame
    reports: pd.DataFrame
    entities: pd.DataFrame
    duplicates: pd.DataFrame
    taxonomies: dict[str, pd.DataFrame]


def _flatten_classifications(bson_path, namespace: str) -> pd.DataFrame:
    """Filter classifications by namespace and flatten their attributes into columns."""
    with open(bson_path, 'rb') as f:
        data = bson.decode_all(f.read())
        
    rows = []
    for doc in data:
        if doc.get('namespace') == namespace:
            # We want one row per incident mapped to this classification document
            incidents = doc.get('incidents', [])
            for inc_id in incidents:
                row = {'Incident ID': inc_id}
                for attr in doc.get('attributes', []):
                    v = attr.get('value_json')
                    if v is not None:
                        try:
                            # Try to decode the inner JSON to a native Python type
                            v = json.loads(v)
                            # To be consistent with CSV extraction, if it's a list, format it as string.
                            # The previous CSV export produced strings like "['A', 'B']"
                            if isinstance(v, list):
                                v = json.dumps(v)
                        except Exception:
                            pass
                    row[attr['short_name']] = v
                rows.append(row)
    return pd.DataFrame(rows)


def _read_bson(path: Path) -> pd.DataFrame:
    """Read a BSON collection file into a DataFrame."""
    with open(path, "rb") as handle:
        return pd.DataFrame(bson.decode_all(handle.read()))


def load_raw_data(paths: SnapshotPaths, config: PipelineConfig) -> RawData:
    """Read required BSON inputs into pandas DataFrames."""
    taxonomies = {
        name: _flatten_classifications(paths.classifications, name)
        for name in config.taxonomies
    }
    return RawData(
        incidents=_read_bson(paths.incidents),
        reports=_read_bson(paths.reports),
        entities=_read_bson(paths.entities),
        duplicates=_read_bson(paths.duplicates),
        taxonomies=taxonomies,
    )
