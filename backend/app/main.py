"""
FastAPI Service Layer for Harmonization of MODIS & VIIRS Hot Spots.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.analytics import (
    query_calendar_series,
    query_kpi_summary,
    query_spatial_summary,
    query_trend_series,
)
from app.db import db_engine
from app.schemas import (
    AOIQueryRequest,
    AOITrendRequest,
    CalendarSeriesResponse,
    KPISummaryResponse,
    SpatialSummaryResponse,
    TrendSeriesResponse,
)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    # Auto-bootstrap Parquet dataset if not yet generated and initialize DuckDB
    db_engine.initialize()
    yield


app = FastAPI(
    title="NASA Space Apps: MODIS & VIIRS Hotspot Harmonization API",
    version="1.0.0",
    description="High-speed DuckDB + H3 spatial-temporal fire harmonization backend.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def get_health() -> Dict:
    return {
        "status": "ok",
        "metadata": db_engine.metadata,
    }


@app.post("/api/aoi/spatial-summary", response_model=SpatialSummaryResponse)
def post_spatial_summary(payload: AOIQueryRequest) -> SpatialSummaryResponse:
    return query_spatial_summary(
        aoi_dict=payload.aoi.model_dump(),
        date_start=payload.date_start,
        date_end=payload.date_end,
        sensor_mode=payload.sensor_mode,
        max_resolution=payload.max_resolution,
        viewport_bbox=payload.viewport_bbox,
    )


@app.post("/api/aoi/kpis", response_model=KPISummaryResponse)
def post_kpi_summary(payload: AOIQueryRequest) -> KPISummaryResponse:
    return query_kpi_summary(
        aoi_dict=payload.aoi.model_dump(),
        date_start=payload.date_start,
        date_end=payload.date_end,
        sensor_mode=payload.sensor_mode,
    )


@app.post("/api/aoi/calendar", response_model=CalendarSeriesResponse)
def post_calendar_series(payload: AOIQueryRequest) -> CalendarSeriesResponse:
    return query_calendar_series(
        aoi_dict=payload.aoi.model_dump(),
        date_start=payload.date_start,
        date_end=payload.date_end,
        sensor_mode=payload.sensor_mode,
    )


@app.post("/api/aoi/trend", response_model=TrendSeriesResponse)
def post_trend_series(payload: AOITrendRequest) -> TrendSeriesResponse:
    return query_trend_series(
        aoi_dict=payload.aoi.model_dump(),
        date_start=payload.date_start,
        date_end=payload.date_end,
        sensor_mode=payload.sensor_mode,
        granularity=payload.granularity,
    )
