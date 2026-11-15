"""
Sensor Harmonization & H3 Spatial-Temporal Alignment Pipeline.

Usage:
    python -m scripts.harmonize_data

3-Stage Data Ingestion:
1. Scans $DATA_DIR/raw/*.csv for raw NASA FIRMS MODIS & VIIRS archives.
2. If present, snaps (latitude, longitude) -> H3 Resolution 8 and buckets by (h3_index, acq_date).
3. If no raw CSVs are present, synthesizes a realistic 2005-2025 Malaysian MODIS + VIIRS dataset.

Harmonization Model (Overlap Regression Calibration + Daily H3 Fusion):
- Uses 2012-present co-located (h3_index, acq_date) pairs where both MODIS and VIIRS
  observed fire activity to calibrate 1km MODIS into 375m VIIRS-equivalent density (factor alpha).
- Preserves raw `modis_count`/`modis_frp`, raw `viirs_count`/`viirs_frp`, and unified
  `harmonized_count`/`harmonized_frp` side-by-side in `/data/harmonized_fires.parquet`.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import h3
import numpy as np
import polars as pl

from app.datapaths import get_data_dir
from scripts.sample_malaysia import generate_malaysia_raw_observations

# --- Global grid configuration -------------------------------------------------
# Fires are stored on H3 hexagons. Inside the Southeast Asian study area we keep
# the fine ~1 km grid (resolution 8); everywhere else a coarse grid (resolution 4)
# keeps a worldwide, multi-decade dataset small enough to ship with the backend.
FINE_RESOLUTION = 8
COARSE_RESOLUTION = int(os.environ.get("HESTIA_COARSE_RESOLUTION", "4"))

# Outside the study area, fires are bucketed into ISO weeks rather than days.
COARSE_WEEKLY = os.environ.get("HESTIA_COARSE_WEEKLY", "1") != "0"

# (lon_min, lat_min, lon_max, lat_max)
STUDY_AREA_BBOX: Tuple[float, float, float, float] = (92.0, -12.0, 142.0, 23.0)
MALAYSIA_BBOX: Tuple[float, float, float, float] = (99.0, 0.5, 119.6, 7.6)


def _in_bbox(lat: float, lon: float, bbox: Tuple[float, float, float, float]) -> bool:
    lon_min, lat_min, lon_max, lat_max = bbox
    return lon_min <= lon <= lon_max and lat_min <= lat <= lat_max


def grid_resolution_for(lat: float, lon: float) -> int:
    """Fine grid within the study area, coarse grid for the rest of the world."""
    return FINE_RESOLUTION if _in_bbox(lat, lon, STUDY_AREA_BBOX) else COARSE_RESOLUTION


# Named fire regions, checked in order; the first box that contains the point wins.
# Ordered most-specific first so Indonesian sub-regions beat the continental boxes.
GLOBAL_REGIONS: List[Tuple[Tuple[float, float, float, float], str]] = [
    ((95.0, -6.0, 107.5, 6.5), "Sumatra & Riau Peatlands"),
    ((108.5, -4.5, 119.0, 2.5), "Kalimantan (Indonesian Borneo)"),
    ((105.0, -11.0, 116.0, -5.0), "Java & Bali"),
    ((116.0, -11.0, 128.0, -5.0), "Nusa Tenggara"),
    ((118.0, -6.0, 127.0, 2.0), "Sulawesi"),
    ((127.0, -8.5, 135.0, 3.0), "Maluku Islands"),
    ((130.0, -11.0, 151.5, 0.5), "New Guinea"),
    ((116.0, 4.5, 127.0, 21.5), "Philippines"),
    ((92.0, 5.5, 110.0, 29.0), "Mainland Southeast Asia"),
    ((60.0, 5.0, 92.0, 37.5), "South Asia"),
    ((100.0, 20.0, 146.0, 54.0), "East Asia"),
    ((60.0, 48.0, 180.0, 75.0), "Siberia & Russian Far East"),
    ((25.0, 12.0, 75.0, 48.0), "Central Asia & Middle East"),
    ((-18.0, 4.0, 25.0, 16.5), "West African Savanna"),
    ((8.0, -6.5, 32.0, 6.5), "Congo Basin"),
    ((28.0, -12.0, 52.0, 18.0), "East Africa"),
    ((10.0, -35.5, 42.0, -6.0), "Southern Africa"),
    ((-18.0, 16.5, 36.0, 35.0), "North Africa & Sahara"),
    ((-12.0, 35.0, 45.0, 72.0), "Europe & Mediterranean"),
    ((-80.0, -15.0, -45.0, 6.0), "Amazon Basin"),
    ((-60.0, -25.0, -34.0, -10.0), "Brazilian Cerrado"),
    ((-76.0, -56.0, -52.0, -25.0), "Southern South America"),
    ((-82.0, 0.0, -58.0, 13.0), "Northern Andes & Orinoco"),
    ((-95.0, 7.0, -58.0, 23.5), "Central America & Caribbean"),
    ((-118.0, 14.0, -86.0, 33.0), "Mexico"),
    ((-170.0, 30.0, -100.0, 72.0), "Western North America"),
    ((-100.0, 24.0, -50.0, 60.0), "Eastern North America"),
    ((113.0, -20.0, 154.0, -9.0), "Northern Australia"),
    ((138.0, -39.5, 154.0, -20.0), "Eastern Australia"),
    ((112.0, -39.5, 138.0, -20.0), "Western & Central Australia"),
    ((165.0, -48.0, 179.5, -33.0), "New Zealand"),
]


# FIRMS archive files are named like "modis_2015_Malaysia.csv" /
# "viirs-snpp_2020_Indonesia.csv". The country in the filename is far more
# reliable than guessing from coordinates, which cannot separate Peninsular
# Malaysia from Sumatra across the Strait of Malacca.
_SENSOR_FILENAME_PREFIX = re.compile(
    r"^(modis|viirs[-_a-z0-9]*|fire)[-_](archive[-_])?(\d{4})[-_]", re.IGNORECASE
)


def country_from_filename(path: str) -> Optional[str]:
    """Pull the country name out of a FIRMS archive filename, if it carries one."""
    stem = os.path.splitext(os.path.basename(path))[0]
    stripped = _SENSOR_FILENAME_PREFIX.sub("", stem)
    if stripped == stem:
        return None
    name = stripped.replace("_", " ").replace("-", " ").strip()
    if not name or not all(part.isalpha() for part in name.split()):
        return None
    return " ".join(part.capitalize() for part in name.split())


# ISO-3166 alpha-3 codes seen in FIRMS exports, for the countries whose fires
# matter most here. Anything else keeps whatever the file said.
ISO3_COUNTRY_NAMES = {
    "MYS": "Malaysia",
    "IDN": "Indonesia",
    "SGP": "Singapore",
    "BRN": "Brunei",
    "THA": "Thailand",
    "VNM": "Vietnam",
    "KHM": "Cambodia",
    "LAO": "Laos",
    "MMR": "Myanmar",
    "PHL": "Philippines",
    "IND": "India",
    "CHN": "China",
    "AUS": "Australia",
    "BRA": "Brazil",
    "USA": "United States",
    "CAN": "Canada",
    "RUS": "Russia",
    "COD": "Democratic Republic of the Congo",
    "AGO": "Angola",
    "ZMB": "Zambia",
    "MOZ": "Mozambique",
    "TZA": "Tanzania",
    "SDN": "Sudan",
    "NGA": "Nigeria",
    "PNG": "Papua New Guinea",
    "MEX": "Mexico",
    "ARG": "Argentina",
    "BOL": "Bolivia",
    "PRY": "Paraguay",
    "COL": "Colombia",
    "VEN": "Venezuela",
    "PER": "Peru",
}


def normalize_country(value: str) -> Optional[str]:
    """Turn a country cell value into a display name, expanding ISO-3 codes."""
    cleaned = (value or "").strip()
    if not cleaned or cleaned.lower() in {"nan", "none", "null"}:
        return None
    if len(cleaned) == 3 and cleaned.isalpha():
        return ISO3_COUNTRY_NAMES.get(cleaned.upper(), cleaned.upper())
    return cleaned


def _malaysian_region(lat: float, lon: float) -> str:
    """State / peatland level detail for Malaysian coordinates."""
    if lon < 105.0:
        if lat < 2.4:
            return "Johor Southern Corridor"
        if lon > 102.6 and lat < 4.2:
            return "Pahang Peatlands (Pekan & Rompin)"
        if lon < 102.0 and 2.5 <= lat <= 3.8:
            return "Selangor Peatlands (Kuala Langat)"
        return "Peninsular Malaysia Northern Belt"
    if lat > 4.6 and lon > 115.0:
        return "Sabah (Klias & Kinabatangan)"
    if lat > 3.5:
        return "Sarawak Miri & Baram Basin"
    return "Sarawak Central & Coastal Peatlands"


def region_name_for(lat: float, lon: float, country: Optional[str] = None) -> str:
    """Region label for a fire, preferring the country the source file declared."""
    if country:
        normalized = country.strip().lower()
        if normalized == "malaysia":
            return _malaysian_region(lat, lon)
        if normalized == "indonesia":
            # Indonesia spans the archipelago; keep island-level detail because
            # Sumatran and Kalimantan peat fires drive the regional haze.
            for bbox, name in GLOBAL_REGIONS:
                if _in_bbox(lat, lon, bbox):
                    return name
            return "Indonesia"
        return country

    return _infer_region_name(lat, lon)


def _infer_region_name(lat: float, lon: float) -> str:
    """Fall back to geography when the source file does not name a country."""
    # Malaysian detail is kept at state / peatland level for the study area.
    if _in_bbox(lat, lon, MALAYSIA_BBOX):
        return _malaysian_region(lat, lon)

    for bbox, name in GLOBAL_REGIONS:
        if _in_bbox(lat, lon, bbox):
            return name

    # Anything left over: label by hemisphere band rather than inventing a place.
    if lat >= 60.0:
        return "Arctic & Boreal"
    if lat <= -60.0:
        return "Antarctic"
    return "Open Ocean & Remote Islands"


# Partial aggregates are merged every this many files. Left to accumulate, the
# per-file frames together hold several times more rows than the merged result.
CONSOLIDATE_EVERY = 150


def _merge_observations(frames: List[pl.DataFrame]) -> pl.DataFrame:
    return (
        pl.concat(frames)
        .group_by(["h3_index", "acq_date", "sensor", "in_study"])
        .agg(pl.col("n").sum(), pl.col("frp_sum").sum())
    )


def _merge_countries(frames: List[pl.DataFrame]) -> pl.DataFrame:
    return (
        pl.concat(frames)
        .group_by(["h3_index", "country"])
        .agg(pl.col("n").sum())
    )


def _ingest_raw_firms_csvs(csv_paths: List[str]) -> Tuple[pl.DataFrame, List[Dict]]:
    """Load raw NASA FIRMS CSV files, convert to H3 Resolution 8, and aggregate by cell-day."""
    frames: List[pl.DataFrame] = []
    country_frames: List[pl.DataFrame] = []
    skipped_rows = 0
    for path in csv_paths:
        try:
            raw_df = pl.read_csv(
                path,
                ignore_errors=True,
                # Archives occasionally arrive with damaged rows (interleaved
                # lines from an interrupted download). Keep the good rows
                # rather than failing the whole run; the validity filter below
                # removes whatever the damage produced.
                truncate_ragged_lines=True,
            )
        except Exception as exc:
            print(f"[ETL] Skipping unreadable file {os.path.basename(path)}: {exc}")
            continue
        cols_lower = {c.lower(): c for c in raw_df.columns}

        country_col = cols_lower.get("country_id") or cols_lower.get("country")
        lat_col = cols_lower.get("latitude") or cols_lower.get("lat")
        lon_col = cols_lower.get("longitude") or cols_lower.get("lon")
        date_col = cols_lower.get("acq_date") or cols_lower.get("date")
        frp_col = cols_lower.get("frp")
        inst_col = cols_lower.get("instrument") or cols_lower.get("satellite")

        if not (lat_col and lon_col and date_col):
            continue

        # Parse leniently, then drop anything that is not a plausible
        # observation. Corrupted rows survive CSV parsing as nonsense values.
        parsed = raw_df.select(
            pl.col(lat_col).cast(pl.Float64, strict=False).alias("lat"),
            pl.col(lon_col).cast(pl.Float64, strict=False).alias("lon"),
            pl.col(date_col)
            .cast(pl.Utf8, strict=False)
            .str.to_date("%Y-%m-%d", strict=False)
            .alias("acq_date"),
            (
                pl.col(frp_col).cast(pl.Float64, strict=False)
                if frp_col
                else pl.lit(20.0, dtype=pl.Float64)
            ).alias("frp"),
            (
                pl.col(inst_col).cast(pl.Utf8, strict=False)
                if inst_col
                else pl.lit(None, dtype=pl.Utf8)
            ).alias("instrument"),
            (
                pl.col(country_col).cast(pl.Utf8, strict=False)
                if country_col
                else pl.lit(None, dtype=pl.Utf8)
            ).alias("country_raw"),
        )

        before = parsed.height
        parsed = parsed.filter(
            pl.col("lat").is_between(-90.0, 90.0)
            & pl.col("lon").is_between(-180.0, 180.0)
            & pl.col("acq_date").is_not_null()
            & pl.col("acq_date").is_between(date(2000, 1, 1), date(2100, 1, 1))
        ).with_columns(pl.col("frp").fill_null(15.0).clip(0.0, 100000.0))

        dropped = before - parsed.height
        if dropped:
            skipped_rows += dropped
            print(
                f"[ETL] {os.path.basename(path)}: dropped {dropped:,} invalid "
                f"row(s) of {before:,}"
            )
        if parsed.height == 0:
            continue

        lats = parsed["lat"].to_list()
        lons = parsed["lon"].to_list()
        h3_cells = [
            h3.latlng_to_cell(
                float(la), float(lo), grid_resolution_for(float(la), float(lo))
            )
            for la, lo in zip(lats, lons)
        ]

        if inst_col:
            inst_vals = [str(v).upper() for v in parsed["instrument"].to_list()]
            sensors = [
                "viirs" if ("VIIRS" in v or v in ("N", "N20", "N21", "SNPP")) else "modis"
                for v in inst_vals
            ]
        else:
            fname = os.path.basename(path).lower()
            default_sensor = "viirs" if "viirs" in fname else "modis"
            sensors = [default_sensor] * len(h3_cells)

        frps = parsed["frp"].to_list()

        # The filename is the most reliable source; the country_id column holds
        # ISO codes ("MYS") that need translating before they reach a map label.
        file_country = country_from_filename(path)
        if file_country:
            countries = [file_country] * len(h3_cells)
        elif country_col:
            countries = [
                normalize_country(str(v)) for v in parsed["country_raw"].to_list()
            ]
        else:
            countries = [None] * len(h3_cells)

        in_study = [
            _in_bbox(float(la), float(lo), STUDY_AREA_BBOX)
            for la, lo in zip(lats, lons)
        ]

        standardized = pl.DataFrame(
            {
                "h3_index": h3_cells,
                "acq_date": parsed["acq_date"],
                "sensor": sensors,
                "frp": frps,
                "country": pl.Series(countries, dtype=pl.Utf8),
                "in_study": pl.Series(in_study, dtype=pl.Boolean),
            }
        ).drop_nulls(["h3_index", "acq_date"])

        if COARSE_WEEKLY:
            # Snap out-of-area detections to the Monday of their ISO week.
            standardized = standardized.with_columns(
                pl.when(pl.col("in_study"))
                .then(pl.col("acq_date"))
                .otherwise(pl.col("acq_date").dt.truncate("1w"))
                .alias("acq_date")
            )

        # Collapse each file to cell-day totals immediately. A whole-planet
        # archive runs to tens of millions of detections, far more than fits in
        # memory at once, but the aggregate of one country-year is small. FRP is
        # carried as a sum so partial aggregates can be merged exactly.
        frames.append(
            standardized.group_by(["h3_index", "acq_date", "sensor", "in_study"]).agg(
                pl.len().cast(pl.Int64).alias("n"),
                pl.col("frp").sum().alias("frp_sum"),
            )
        )
        country_frames.append(
            standardized.drop_nulls("country")
            .group_by(["h3_index", "country"])
            .agg(pl.len().alias("n"))
        )
        del standardized, raw_df

        if len(frames) >= CONSOLIDATE_EVERY:
            frames = [_merge_observations(frames)]
            country_frames = [_merge_countries(country_frames)]

    if skipped_rows:
        print(f"[ETL] Dropped {skipped_rows:,} invalid row(s) across all files")

    if not frames:
        raise ValueError("No valid NASA FIRMS CSV files could be parsed from raw directory.")

    combined = _merge_observations(frames)
    del frames

    def _per_sensor(sensor: str, count_name: str, frp_name: str) -> pl.DataFrame:
        return (
            combined.filter(pl.col("sensor") == sensor)
            .select(
                "h3_index",
                "acq_date",
                "in_study",
                pl.col("n").cast(pl.Int32).alias(count_name),
                (pl.col("frp_sum") / pl.col("n")).round(2).alias(frp_name),
            )
        )

    modis_daily = _per_sensor("modis", "modis_count", "modis_frp")
    viirs_daily = _per_sensor("viirs", "viirs_count", "viirs_frp")

    daily = modis_daily.join(
        viirs_daily, on=["h3_index", "acq_date", "in_study"], how="full", coalesce=True
    ).with_columns(
        pl.col("modis_count").fill_null(0).cast(pl.Int32),
        pl.col("modis_frp").fill_null(0.0).cast(pl.Float64),
        pl.col("viirs_count").fill_null(0).cast(pl.Int32),
        pl.col("viirs_frp").fill_null(0.0).cast(pl.Float64),
    )

    # Most frequent country per cell; a hexagon is small enough that this is
    # unambiguous except right on a border.
    cell_country = {
        row["h3_index"]: row["country"]
        for row in _merge_countries(country_frames)
        .sort(["h3_index", "n"], descending=[False, True])
        .unique(subset=["h3_index"], keep="first")
        .to_dicts()
    }

    unique_cells = daily["h3_index"].unique().to_list()
    hex_pool = []
    for cell_id in unique_cells:
        c_lat, c_lon = h3.cell_to_latlng(cell_id)
        hex_pool.append(
            {
                "h3_index": cell_id,
                "cell_lat": round(c_lat, 6),
                "cell_lon": round(c_lon, 6),
                "region_name": region_name_for(c_lat, c_lon, cell_country.get(cell_id)),
            }
        )

    return daily, hex_pool


def run_harmonization_pipeline(force: bool = False) -> Dict:
    """Execute the full H3 spatial-temporal harmonization pipeline and output Parquet files."""
    data_dir = get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = data_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    fires_parquet_path = data_dir / "harmonized_fires.parquet"
    cells_parquet_path = data_dir / "active_cells.parquet"
    metadata_path = data_dir / "metadata.json"

    if (
        not force
        and fires_parquet_path.exists()
        and cells_parquet_path.exists()
        and metadata_path.exists()
    ):
        with open(metadata_path, "r", encoding="utf-8") as f:
            return json.load(f)

    csv_files = sorted(str(p) for p in raw_dir.rglob("*.csv"))
    if csv_files:
        print(f"[ETL] Found {len(csv_files)} raw NASA FIRMS CSV file(s). Ingesting...")
        daily_df, hex_pool = _ingest_raw_firms_csvs(csv_files)
        source_mode = "nasa_firms_csv"
    else:
        print("[ETL] No raw CSVs in /data/raw. Generating multi-decade dataset (2005-2026)...")
        daily_df, hex_pool = generate_malaysia_raw_observations(2005, 2026)
        source_mode = "malaysia_multi_decade_model"

    # Step 2: Fit Overlap Calibration Factor (2012-present co-located observations)
    viirs_launch = date(2012, 1, 20)
    # Calibrate only where both sensors are on the same footing: the study
    # area's fine daily grid. Mixing it with the coarse weekly buckets used
    # elsewhere inflates the ratio, because a weekly bucket pairs a single
    # MODIS detection with a whole week of VIIRS ones.
    if "in_study" in daily_df.columns:
        calibration_source = daily_df.filter(pl.col("in_study"))
    else:
        calibration_source = daily_df

    overlap_df = calibration_source.filter(
        (pl.col("acq_date") >= viirs_launch)
        & (pl.col("modis_count") > 0)
        & (pl.col("viirs_count") > 0)
    )

    if overlap_df.height > 10:
        sum_viirs = float(overlap_df["viirs_count"].sum())
        sum_modis = float(overlap_df["modis_count"].sum())
        alpha_count = round(sum_viirs / max(sum_modis, 1.0), 4)

        mean_v_frp = float(overlap_df["viirs_frp"].mean())
        mean_m_frp = float(overlap_df["modis_frp"].mean())
        gamma_frp = round(mean_v_frp / max(mean_m_frp, 1.0), 4)
    else:
        alpha_count = 3.25
        gamma_frp = 0.82

    print(
        f"[ETL] Calibrated Overlap Model (n={overlap_df.height:,} co-located hex-days): "
        f"alpha_count={alpha_count:.3f}, gamma_frp={gamma_frp:.3f}"
    )

    # Step 3: Compute Unified `harmonized_count` and `harmonized_frp` + ISO Week Calendar Fields
    # Note: ISO week 53 is folded into week 52 for consistent 52-week seasonal matrix alignment
    harmonized_df = (
        daily_df.with_columns(
            [
                pl.when((pl.col("modis_count") > 0) & (pl.col("viirs_count") > 0))
                .then(
                    (
                        0.70 * pl.col("viirs_count")
                        + 0.30 * (pl.col("modis_count") * alpha_count)
                    )
                    .round(0)
                    .cast(pl.Int32)
                )
                .when(pl.col("viirs_count") > 0)
                .then(pl.col("viirs_count"))
                .otherwise(
                    (pl.col("modis_count") * alpha_count)
                    .round(0)
                    .cast(pl.Int32)
                    .clip(lower_bound=1)
                )
                .alias("harmonized_count"),
                pl.when((pl.col("modis_count") > 0) & (pl.col("viirs_count") > 0))
                .then(
                    (
                        0.70 * pl.col("viirs_frp")
                        + 0.30 * (pl.col("modis_frp") * gamma_frp)
                    ).round(2)
                )
                .when(pl.col("viirs_count") > 0)
                .then(pl.col("viirs_frp"))
                .otherwise((pl.col("modis_frp") * gamma_frp).round(2))
                .alias("harmonized_frp"),
            ]
        )
        # Compact storage: counts fit in 16 bits, FRP needs no more than one
        # decimal, and sorting by cell lets zstd collapse the repeated H3 text.
        # ISO year/week and week_start_date are dropped: every query derives
        # them from acq_date instead. Together this roughly halves the file.
        .with_columns(
            pl.col("modis_count").cast(pl.UInt16),
            pl.col("viirs_count").cast(pl.UInt16),
            pl.col("harmonized_count").cast(pl.UInt16),
            pl.col("modis_frp").round(1).cast(pl.Float32),
            pl.col("viirs_frp").round(1).cast(pl.Float32),
            pl.col("harmonized_frp").round(1).cast(pl.Float32),
        )
        .drop("in_study", strict=False)
        .sort(["h3_index", "acq_date"])
    )

    cells_df = pl.DataFrame(
        [
            {
                "h3_index": h["h3_index"],
                "cell_lat": float(h["cell_lat"]),
                "cell_lon": float(h["cell_lon"]),
                "region_name": str(h["region_name"]),
            }
            for h in hex_pool
        ]
    ).sort("h3_index")

    # Write compressed Parquet tables
    harmonized_df.write_parquet(fires_parquet_path, compression="zstd")
    cells_df.write_parquet(cells_parquet_path, compression="zstd")

    metadata = {
        "source_mode": source_mode,
        "h3_resolution": FINE_RESOLUTION,
        "h3_resolution_fine": FINE_RESOLUTION,
        "h3_resolution_coarse": COARSE_RESOLUTION,
        "study_area_bbox": list(STUDY_AREA_BBOX),
        "coarse_weekly_outside_study_area": COARSE_WEEKLY,
        "calibration_scope": "study_area_fine_daily_grid",
        "calibration_alpha_count": alpha_count,
        "calibration_gamma_frp": gamma_frp,
        "overlap_sample_size": int(overlap_df.height),
        "total_hex_days": int(harmonized_df.height),
        "unique_active_h3_cells": int(cells_df.height),
        "date_min": str(harmonized_df["acq_date"].min()),
        "date_max": str(harmonized_df["acq_date"].max()),
    }

    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)

    print(
        f"[ETL] Wrote {harmonized_df.height:,} hex-day records across "
        f"{cells_df.height:,} active H3 Resolution 8 cells to {data_dir}"
    )
    return metadata


if __name__ == "__main__":
    run_harmonization_pipeline(force=True)
