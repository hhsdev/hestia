"""
Where the pre-computed Parquet dataset lives.

Kept free of heavy imports (polars, numpy) so the serving path can locate the
data without pulling in the ETL's dependencies.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

DATASET_FILES = ("harmonized_fires.parquet", "active_cells.parquet", "metadata.json")


def _is_complete(directory: Path) -> bool:
    return all((directory / name).exists() for name in DATASET_FILES)


def get_data_dir() -> Path:
    """Resolve the data directory, preferring a dataset that is already built."""
    env_dir = os.environ.get("DATA_DIR")
    if env_dir:
        return Path(env_dir)

    backend_root = Path(__file__).resolve().parent.parent

    # Shipped with the backend: the only copy a serverless deployment can see,
    # since the bundle is rooted at ./backend.
    bundled = backend_root / "data"
    if _is_complete(bundled):
        return bundled

    # Repository-level ./data, used by docker compose and local development.
    repo_data_dir = backend_root.parent / "data"
    if _is_complete(repo_data_dir):
        return repo_data_dir

    if os.environ.get("VERCEL"):
        return Path(tempfile.gettempdir()) / "hestia_data"

    try:
        repo_data_dir.mkdir(parents=True, exist_ok=True)
        return repo_data_dir
    except OSError:
        return Path(tempfile.gettempdir()) / "hestia_data"
