import {
  AOIQueryPayload,
  AOITrendPayload,
  CalendarSeriesResponse,
  HealthMetadata,
  KPISummaryResponse,
  SpatialSummaryResponse,
  TrendSeriesResponse,
} from "../types/api";

const API_BASE_URL =
  import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export async function fetchSpatialSummary(
  payload: AOIQueryPayload,
  signal?: AbortSignal
): Promise<SpatialSummaryResponse> {
  const res = await fetch(`${API_BASE_URL}/api/aoi/spatial-summary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Spatial Summary API failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchKpiSummary(
  payload: AOIQueryPayload,
  signal?: AbortSignal
): Promise<KPISummaryResponse> {
  const res = await fetch(`${API_BASE_URL}/api/aoi/kpis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    throw new Error(`KPI Summary API failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchCalendarSeries(
  payload: AOIQueryPayload,
  signal?: AbortSignal
): Promise<CalendarSeriesResponse> {
  const res = await fetch(`${API_BASE_URL}/api/aoi/calendar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Calendar API failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchTrendSeries(
  payload: AOITrendPayload,
  signal?: AbortSignal
): Promise<TrendSeriesResponse> {
  const res = await fetch(`${API_BASE_URL}/api/aoi/trend`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Trend API failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchHealthMetadata(): Promise<HealthMetadata> {
  const res = await fetch(`${API_BASE_URL}/api/health`);
  if (!res.ok) {
    throw new Error(`Health API failed: ${res.status}`);
  }
  const json = await res.json();
  return json.metadata || {};
}
