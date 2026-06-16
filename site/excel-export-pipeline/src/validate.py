from __future__ import annotations

from dataclasses import dataclass
import pandas as pd


@dataclass
class ValidationResult:
    """Validation results split into hard errors vs soft warnings."""

    errors: list[str]
    warnings: list[str]

    @property
    def ok(self) -> bool:
        """True if the dataset passed all error-level checks."""
        return len(self.errors) == 0


def validate_dataset(dataset: pd.DataFrame, inc_core: pd.DataFrame) -> ValidationResult:
    """Validate relational integrity, uniqueness, and completeness."""
    errors: list[str] = []
    warnings: list[str] = []

    def _check(condition: bool, error_msg: str, warning: bool = False) -> None:
        """Append an error/warning if a check fails."""
        if condition:
            return
        if warning:
            warnings.append(error_msg)
        else:
            errors.append(error_msg)

    # File integrity validations check for 0 bytes upstream. Here we just ensure we loaded something.
    _check(len(dataset) > 0, "Dataset is empty.")

    # Primary key should remain unique after joins.
    dupes = dataset["Incident ID"].duplicated().sum()
    _check(dupes == 0, f"Found {dupes} duplicate Incident IDs")

    core_cols = [
        "Incident ID",
        "date",
        "year",
        "title",
        "description",
        "deployer",
        "developer",
        "harmed",
        "report_count",
        "Data Sources",
    ]
    for col in core_cols:
        if col in dataset.columns:
            nulls = dataset[col].isnull().sum()
            _check(nulls == 0, f"{col} has {nulls} nulls (should be 0)")

    # Soft sanity check on time range.
    if "year" in dataset.columns:
        yr_min, yr_max = dataset["year"].min(), dataset["year"].max()
        _check(
            pd.notna(yr_min) and yr_min >= 1980 and pd.notna(yr_max) and yr_max >= 2024,
            f"Unexpected year range: {yr_min} -> {yr_max}",
            warning=True,
        )

    # Ensure joins did not increase row count (should stay 1 row per incident).
    _check(
        len(dataset) == len(inc_core),
        f"Row explosion: dataset has {len(dataset)} rows but core incidents has {len(inc_core)}",
    )

    return ValidationResult(errors=errors, warnings=warnings)
