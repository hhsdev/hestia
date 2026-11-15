"""
Pydantic API Schemas strictly adhering to Section 3 of project_manifest.md.
"""

from __future__ import annotations

from typing import List, Literal, Optional, Tuple
from pydantic import BaseModel, Field, field_validator


class GeoJSONPolygon(BaseModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: List[List[List[float]]] = Field(
        ...,
        description="GeoJSON Polygon coordinates array [[[lon, lat], ...]]",
    )


TimescaleType = Literal["daily", "weekly", "monthly", "yearly", "5y", "10y"]


def _normalize_sensor_mode(v: str) -> str:
    clean = v.strip().lower()
    if "modis" in clean:
        return "modis"
    if "viirs" in clean:
        return "viirs"
    return "harmonized"


class AOIQueryRequest(BaseModel):
    aoi: GeoJSONPolygon
    date_start: str = Field(..., examples=["2015-01-01"])
    date_end: str = Field(..., examples=["2025-12-31"])
    sensor_mode: str = Field(default="harmonized", examples=["harmonized"])
    max_resolution: Optional[int] = Field(default=None, ge=0, le=8)
    viewport_bbox: Optional[Tuple[float, float, float, float]] = None

    @field_validator("sensor_mode")
    @classmethod
    def normalize_sensor_mode(cls, v: str) -> str:
        return _normalize_sensor_mode(v)


class AOITrendRequest(BaseModel):
    aoi: GeoJSONPolygon
    date_start: str = Field(..., examples=["2025-01-01"])
    date_end: str = Field(..., examples=["2025-12-31"])
    sensor_mode: str = Field(default="harmonized", examples=["harmonized"])
    granularity: TimescaleType = Field(default="weekly")

    @field_validator("sensor_mode")
    @classmethod
    def normalize_sensor_mode(cls, v: str) -> str:
        return _normalize_sensor_mode(v)


class SpatialHexRecord(BaseModel):
    h3_index: str
    total_fires: int
    mean_frp: float


class SpatialSummaryResponse(BaseModel):
    status: str = "success"
    data: List[SpatialHexRecord]


class KPISummaryResponse(BaseModel):
    status: str = "success"
    total_fires: int
    active_zones: int
    mean_frp: float


class CalendarSeasonSummary(BaseModel):
    critical_season_start: str
    critical_season_end: str


class CalendarTimeSeriesPoint(BaseModel):
    date: str
    harmonized_count: int
    historical_mean: float
    z_score: float
    is_anomaly: bool


class CalendarSeriesResponse(BaseModel):
    status: str = "success"
    summary: CalendarSeasonSummary
    time_series: List[CalendarTimeSeriesPoint]


class TrendPoint(BaseModel):
    slice_start: str
    slice_end: str
    label: str
    count: int
    historical_mean: float
    z_score: float
    is_anomaly: bool


class TrendSeriesResponse(BaseModel):
    status: str = "success"
    granularity: TimescaleType
    time_series: List[TrendPoint]
