import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertOctagon,
  Calendar,
  CalendarRange,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Flame,
  Hexagon,
  Pause,
  Play,
  Radio,
  Satellite,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  fetchCalendarSeries,
  fetchHealthMetadata,
  fetchKpiSummary,
  fetchSpatialSummary,
  fetchTrendSeries,
} from "./api/client";
import { CalendarHeatmap } from "./components/CalendarHeatmap";
import * as h3 from "h3-js";
import { MALAYSIA_PRESET_AOIS } from "./constants/presets";
import { ClimatologyChart } from "./components/ClimatologyChart";
import { MapView } from "./components/MapView";
import { InfoTooltip, Tooltip } from "./components/Tooltip";
import {
  CalendarSummary,
  CalendarTimeSeriesPoint,
  GeoJSONPolygon,
  SensorMode,
  SpatialHexDatum,
  Timescale,
  TrendPoint,
} from "./types/api";
import {
  TIMESCALE_OPTIONS,
  addDays,
  clampDate,
  countStepsInBounds,
  daysBetween,
  getIntervalForDate,
  getTrendFetchRange,
  stepAnchor,
} from "./utils/timeline";

const WORLD_AOI: GeoJSONPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-180.0, -90.0],
      [180.0, -90.0],
      [180.0, 90.0],
      [-180.0, 90.0],
      [-180.0, -90.0],
    ],
  ],
};

// The region the statistics and charts describe when the page first loads.
// The map itself always draws the whole world, so the globe stays populated
// while the numbers stay meaningful for somewhere in particular.
const DEFAULT_ANALYSIS_AOI: GeoJSONPolygon =
  MALAYSIA_PRESET_AOIS[0]?.polygon ?? WORLD_AOI;

// Detections outside the study area are stored one bucket per week, stamped on
// that week's Monday. Shown on a daily view they would read as a huge Monday
// spike and six empty days, so the daily view is limited to the study area,
// which is stored day by day. Fine cells are resolution 8; coarse ones are 4.
const FINE_GRID_RESOLUTION = 8;

type PlaybackSpeed = 1 | 2 | 4;

export const App: React.FC = () => {
  const [aoi, setAoi] = useState<GeoJSONPolygon>(DEFAULT_ANALYSIS_AOI);
  // False until the user draws something: the default region feeds the
  // headline figures, but nothing is outlined on a map nobody has touched.
  const [hasCustomAoi, setHasCustomAoi] = useState<boolean>(false);
  // Aggregated KPI figures for the selected analysis AOI & slice.
  const [regionKpis, setRegionKpis] = useState<{
    totalFires: number;
    activeZoneCount: number;
    avgFrp: number;
  }>({
    totalFires: 0,
    activeZoneCount: 0,
    avgFrp: 0,
  });
  // True when the dataset stores the world outside the study area weekly.
  const [coarseWeekly, setCoarseWeekly] = useState<boolean>(false);

  const [dataBounds, setDataBounds] = useState<{ min: string; max: string }>({
    min: "2005-01-01",
    max: "2026-11-10",
  });
  const [metadataReady, setMetadataReady] = useState<boolean>(false);

  const [timescale, setTimescale] = useState<Timescale>("weekly");
  const [boundsStart, setBoundsStart] = useState<string>("2005-01-01");
  const [boundsEnd, setBoundsEnd] = useState<string>("2026-11-10");
  const [cursorDate, setCursorDate] = useState<string>("2026-11-10");

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [sensorMode, setSensorMode] = useState<SensorMode>("harmonized");

  const startDateInputRef = useRef<HTMLInputElement>(null);
  const endDateInputRef = useRef<HTMLInputElement>(null);

  const openDatePicker = (ref: React.RefObject<HTMLInputElement>) => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        // Fallback to focus if showPicker fails
      }
    }
    el.focus();
  };

  // API response state
  const [hexData, setHexData] = useState<SpatialHexDatum[]>([]);
  const [calendarSeries, setCalendarSeries] = useState<
    CalendarTimeSeriesPoint[]
  >([]);
  const [calendarSummary, setCalendarSummary] = useState<CalendarSummary>({
    critical_season_start: "06-30",
    critical_season_end: "09-28",
  });
  const [trendSeries, setTrendSeries] = useState<TrendPoint[]>([]);

  const [loadingMap, setLoadingMap] = useState<boolean>(false);
  const [loadingCalendar, setLoadingCalendar] = useState<boolean>(false);
  const [loadingTrend, setLoadingTrend] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Zoom- and viewport-bucketed spatial resolution requested for map rendering
  const [spatialView, setSpatialView] = useState<{
    maxResolution: number;
    viewportBbox: [number, number, number, number] | null;
  }>({
    maxResolution: 2,
    viewportBbox: null,
  });

  const handleMapViewChange = useCallback(
    (next: {
      maxResolution: number;
      viewportBbox: [number, number, number, number] | null;
    }) => {
      setSpatialView((prev) => {
        if (
          prev.maxResolution === next.maxResolution &&
          ((prev.viewportBbox === null && next.viewportBbox === null) ||
            (prev.viewportBbox !== null &&
              next.viewportBbox !== null &&
              prev.viewportBbox[0] === next.viewportBbox[0] &&
              prev.viewportBbox[1] === next.viewportBbox[1] &&
              prev.viewportBbox[2] === next.viewportBbox[2] &&
              prev.viewportBbox[3] === next.viewportBbox[3]))
        ) {
          return prev;
        }
        return next;
      });
    },
    []
  );

  // Bounded client-side frame cache for silky-smooth animated loop playback
  const spatialCacheRef = useRef<Map<string, SpatialHexDatum[]>>(new Map());
  const aoiKey = useMemo(() => JSON.stringify(aoi), [aoi]);

  // Bootstrap date bounds & start cursor at dataset date_max ("latest / today")
  useEffect(() => {
    let active = true;
    fetchHealthMetadata()
      .then((meta) => {
        if (!active) return;
        const minDt = meta.date_min || "2005-01-01";
        const maxDt = meta.date_max || "2026-11-10";
        setDataBounds({ min: minDt, max: maxDt });
        setCoarseWeekly(Boolean(meta.coarse_weekly_outside_study_area));
        setBoundsStart(minDt);
        setBoundsEnd(maxDt);
        setCursorDate(maxDt);
      })
      .catch(() => {
        // Fall back gracefully to default bounds if health check fails
      })
      .finally(() => {
        if (active) setMetadataReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Compute active slice bounds [start, end] inside playback loop [boundsStart, boundsEnd]
  const activeSlice = useMemo(
    () => getIntervalForDate(cursorDate, timescale, boundsStart, boundsEnd),
    [cursorDate, timescale, boundsStart, boundsEnd]
  );

  const stepsInBounds = useMemo(
    () => countStepsInBounds(timescale, boundsStart, boundsEnd),
    [timescale, boundsStart, boundsEnd]
  );

  // Outer multi-year bounds for the calendar heatmap
  const calendarStart = boundsStart < dataBounds.min ? boundsStart : dataBounds.min;
  const calendarEnd = boundsEnd > dataBounds.max ? boundsEnd : dataBounds.max;

  // Fetch Calendar time-series whenever AOI, sensorMode, or outer dataset bounds change
  useEffect(() => {
    if (!metadataReady) return;
    const controller = new AbortController();
    setLoadingCalendar(true);
    setErrorMsg(null);

    fetchCalendarSeries(
      {
        aoi,
        date_start: calendarStart,
        date_end: calendarEnd,
        sensor_mode: sensorMode,
      },
      controller.signal
    )
      .then((res) => {
        setCalendarSeries(res.time_series);
        setCalendarSummary(res.summary);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setErrorMsg(err.message || "Failed to load calendar series");
        }
      })
      .finally(() => {
        setLoadingCalendar(false);
      });

    return () => controller.abort();
  }, [metadataReady, aoi, calendarStart, calendarEnd, sensorMode]);

  // Rolling/cached fetch range for Burning Activity Trend across all 6 timescales
  const currentTrendSignature = `${aoiKey}|${sensorMode}|${timescale}|${calendarStart}|${calendarEnd}`;
  const [trendWindow, setTrendWindow] = useState<{
    signature: string;
    start: string;
    end: string;
  } | null>(null);

  useEffect(() => {
    if (!metadataReady) return;
    const needsInitialOrSchemaReload =
      !trendWindow || trendWindow.signature !== currentTrendSignature;
    const needsRollingShift =
      Boolean(trendWindow) &&
      timescale === "daily" &&
      daysBetween(calendarStart, calendarEnd) > 450 &&
      ((cursorDate < addDays(trendWindow!.start, 30) &&
        trendWindow!.start > calendarStart) ||
        (cursorDate > addDays(trendWindow!.end, -30) &&
          trendWindow!.end < calendarEnd));

    if (needsInitialOrSchemaReload || needsRollingShift) {
      const desired = getTrendFetchRange(
        cursorDate,
        timescale,
        boundsStart,
        boundsEnd,
        dataBounds.min,
        dataBounds.max
      );
      setTrendWindow({
        signature: currentTrendSignature,
        start: desired.start,
        end: desired.end,
      });
    }
  }, [
    metadataReady,
    currentTrendSignature,
    timescale,
    calendarStart,
    calendarEnd,
    cursorDate,
    boundsStart,
    boundsEnd,
    dataBounds.min,
    dataBounds.max,
    trendWindow,
  ]);

  useEffect(() => {
    if (
      !metadataReady ||
      !trendWindow ||
      trendWindow.signature !== currentTrendSignature
    ) {
      return;
    }
    const controller = new AbortController();
    setLoadingTrend(true);

    fetchTrendSeries(
      {
        aoi,
        date_start: trendWindow.start,
        date_end: trendWindow.end,
        sensor_mode: sensorMode,
        granularity: timescale,
      },
      controller.signal
    )
      .then((res) => {
        setTrendSeries(res.time_series);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setErrorMsg(err.message || "Failed to load trend series");
        }
      })
      .finally(() => {
        setLoadingTrend(false);
      });

    return () => controller.abort();
  }, [
    metadataReady,
    aoi,
    trendWindow,
    currentTrendSignature,
    sensorMode,
    timescale,
  ]);

  const mapAoi = hasCustomAoi ? aoi : WORLD_AOI;
  const mapAoiKey = hasCustomAoi ? aoiKey : "world";
  const mapMaxRes = hasCustomAoi
    ? Math.max(spatialView.maxResolution, 4)
    : spatialView.maxResolution;
  const mapViewportBbox = spatialView.viewportBbox;
  const mapViewKey = `${mapMaxRes}|${
    mapViewportBbox ? mapViewportBbox.join(",") : "global"
  }`;

  // Fetch helper with bounded client-side frame cache (up to 450 slices)
  const loadSpatialSlice = useCallback(
    async (
      sliceStart: string,
      sliceEnd: string,
      signal: AbortSignal
    ): Promise<SpatialHexDatum[]> => {
      const cacheKey = `${mapAoiKey}|${mapViewKey}|${sensorMode}|${sliceStart}|${sliceEnd}`;
      const hit = spatialCacheRef.current.get(cacheKey);
      if (hit) return hit;

      const res = await fetchSpatialSummary(
        {
          aoi: mapAoi,
          date_start: sliceStart,
          date_end: sliceEnd,
          sensor_mode: sensorMode,
          max_resolution: mapMaxRes,
          ...(mapViewportBbox ? { viewport_bbox: mapViewportBbox } : {}),
        },
        signal
      );

      if (spatialCacheRef.current.size >= 450) {
        const oldestKey = spatialCacheRef.current.keys().next().value;
        if (oldestKey !== undefined) {
          spatialCacheRef.current.delete(oldestKey);
        }
      }
      spatialCacheRef.current.set(cacheKey, res.data);
      return res.data;
    },
    [mapAoi, mapAoiKey, mapMaxRes, mapViewportBbox, mapViewKey, sensorMode]
  );

  // Spatial map summary + coordinated playback timer with next-frame prefetch
  useEffect(() => {
    if (!metadataReady) return;
    const controller = new AbortController();
    let timerId: number | null = null;
    let cancelled = false;

    const run = async () => {
      const cacheKey = `${mapAoiKey}|${mapViewKey}|${sensorMode}|${activeSlice.start}|${activeSlice.end}`;
      const cached = spatialCacheRef.current.get(cacheKey);
      if (cached) {
        setHexData(cached);
        setLoadingMap(false);
      } else {
        setLoadingMap(true);
      }

      const startMs = performance.now();
      try {
        const data = cached
          ? cached
          : await loadSpatialSlice(
              activeSlice.start,
              activeSlice.end,
              controller.signal
            );
        if (cancelled) return;
        setHexData(data);
        setLoadingMap(false);

        if (!isPlaying) return;

        if (stepsInBounds <= 1) {
          setIsPlaying(false);
          return;
        }

        const nextAnchor = stepAnchor(
          cursorDate,
          timescale,
          1,
          boundsStart,
          boundsEnd
        );
        const nextSlice = getIntervalForDate(
          nextAnchor,
          timescale,
          boundsStart,
          boundsEnd
        );
        const prefetchPromise = loadSpatialSlice(
          nextSlice.start,
          nextSlice.end,
          controller.signal
        ).catch(() => {});

        const baseDelay =
          playbackSpeed === 4 ? 175 : playbackSpeed === 2 ? 350 : 700;
        const elapsed = performance.now() - startMs;
        const waitMs = Math.max(16, baseDelay - elapsed);

        await Promise.all([
          prefetchPromise,
          new Promise<void>((resolve) => {
            timerId = window.setTimeout(resolve, waitMs);
          }),
        ]);

        if (!cancelled) {
          setCursorDate(nextAnchor);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const e = err as { name?: string; message?: string };
        if (e?.name !== "AbortError") {
          setLoadingMap(false);
          setIsPlaying(false);
          setErrorMsg(e?.message || "Failed to load spatial summary");
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    metadataReady,
    aoiKey,
    hasCustomAoi,
    mapAoiKey,
    mapViewKey,
    sensorMode,
    activeSlice.start,
    activeSlice.end,
    isPlaying,
    playbackSpeed,
    stepsInBounds,
    cursorDate,
    timescale,
    boundsStart,
    boundsEnd,
    loadSpatialSlice,
  ]);

  const handleStep = useCallback(
    (delta: -1 | 1) => {
      setIsPlaying(false);
      setCursorDate((prev) =>
        stepAnchor(prev, timescale, delta, boundsStart, boundsEnd)
      );
    },
    [timescale, boundsStart, boundsEnd]
  );

  const handleTogglePlay = useCallback(() => {
    if (stepsInBounds <= 1) return;
    setIsPlaying((prev) => !prev);
  }, [stepsInBounds]);

  const handleCycleSpeed = useCallback(() => {
    setPlaybackSpeed((prev) => (prev === 1 ? 2 : prev === 2 ? 4 : 1));
  }, []);

  const handleJumpToDate = useCallback(
    (dateStr: string) => {
      setIsPlaying(false);
      // Expand loop bounds gracefully if clicking a cell outside the custom sub-range
      if (dateStr < boundsStart) {
        setBoundsStart(dateStr);
      }
      if (dateStr > boundsEnd) {
        setBoundsEnd(dateStr);
      }
      setCursorDate(dateStr);
    },
    [boundsStart, boundsEnd]
  );

  const handleCustomAoi = useCallback((newAoi: GeoJSONPolygon) => {
    setAoi(newAoi);
    setHasCustomAoi(true);
  }, []);

  const handleResetAoi = useCallback(() => {
    setAoi(DEFAULT_ANALYSIS_AOI);
    setHasCustomAoi(false);
  }, []);

  // Highlight active viewing slice on the Burning Activity Calendar
  const highlightedDateRange = useMemo(
    () => ({ start: activeSlice.start, end: activeSlice.end }),
    [activeSlice.start, activeSlice.end]
  );

  // Headline KPI aggregation computed server-side so multi-year (5y+) intervals
  // never download or reduce millions of per-hex rows in the browser.
  useEffect(() => {
    if (!metadataReady) return;
    const controller = new AbortController();
    let cancelled = false;

    fetchKpiSummary(
      {
        aoi,
        date_start: activeSlice.start,
        date_end: activeSlice.end,
        sensor_mode: sensorMode,
      },
      controller.signal
    )
      .then((res) => {
        if (!cancelled) {
          setRegionKpis({
            totalFires: res.total_fires,
            activeZoneCount: res.active_zones,
            avgFrp: res.mean_frp,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRegionKpis({ totalFires: 0, activeZoneCount: 0, avgFrp: 0 });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    metadataReady,
    aoiKey,
    aoi,
    sensorMode,
    activeSlice.start,
    activeSlice.end,
  ]);

  // Daily view: the backend withholds weekly-stored cells from windows shorter
  // than a week; this guards the map the same way and tells MapView to say so.
  const dailyStudyAreaOnly = timescale === "daily" && coarseWeekly;
  const mapHexData = useMemo(() => {
    if (!dailyStudyAreaOnly) return hexData;
    const minExpectedRes = Math.min(FINE_GRID_RESOLUTION, mapMaxRes);
    return hexData.filter((d) => {
      try {
        return h3.getResolution(d.h3_index) >= minExpectedRes;
      } catch {
        return true;
      }
    });
  }, [hexData, dailyStudyAreaOnly, mapMaxRes]);

  // Compute top-level KPI metrics for the active viewing slice & loop range anomalies
  const kpiStats = useMemo(() => {
    let anomalyWeeks = 0;
    let peakAnomaly: CalendarTimeSeriesPoint | null = null;
    for (const pt of calendarSeries) {
      if (pt.date >= boundsStart && pt.date <= boundsEnd && pt.is_anomaly) {
        anomalyWeeks += 1;
        if (!peakAnomaly || pt.z_score > peakAnomaly.z_score) {
          peakAnomaly = pt;
        }
      }
    }

    return {
      totalFires: regionKpis.totalFires,
      activeZoneCount: regionKpis.activeZoneCount,
      avgFrp: regionKpis.avgFrp,
      anomalyWeeks,
      peakAnomaly,
    };
  }, [regionKpis, calendarSeries, boundsStart, boundsEnd]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Top Navigation & Timeline Controls Bar */}
      <header className="border-b border-slate-800/90 bg-slate-900/80 backdrop-blur-md px-4 py-2.5 sticky top-0 z-30">
        <div className="max-w-[1800px] mx-auto flex flex-wrap xl:flex-nowrap items-center justify-between gap-2">
          {/* Brand Title */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 via-orange-600 to-rose-600 flex items-center justify-center shadow-lg shadow-orange-500/20 shrink-0">
              <Flame className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-wider text-white leading-tight">
                HESTIA
              </h1>
              <p className="text-[11px] text-slate-400 leading-tight whitespace-nowrap">
                Harmonized Earth Sensors for Thermal Intensity Analysis
              </p>
            </div>
          </div>

          {/* Right Controls: Timescale + Transport, Loop Bounds & Sensor Mode */}
          <div className="flex flex-wrap xl:flex-nowrap items-center gap-1.5 shrink-0">
            {/* Timescale Selector + Step/Play Transport Group */}
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg text-xs shrink-0">
              {/* Timescale Dropdown (fixed width prevents layout shift across presets) */}
              <div className="relative flex items-center border-r border-slate-800">
                <select
                  aria-label="Timeline interval scale"
                  value={timescale}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setTimescale(e.target.value as Timescale);
                  }}
                  className="w-[128px] appearance-none bg-transparent text-sky-300 font-semibold pl-2.5 pr-6 py-1.5 rounded-l-lg cursor-pointer focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                >
                  {TIMESCALE_OPTIONS.map((opt) => (
                    <option
                      key={opt.id}
                      value={opt.id}
                      className="bg-slate-900 text-slate-100"
                    >
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 pointer-events-none absolute right-1.5" />
              </div>

              {/* Three Transport Buttons: Left Chevron | Play/Pause | Right Chevron */}
              <div className="flex items-center gap-0.5 px-1">
                <Tooltip
                  position="bottom"
                  align="center"
                  content={`Step backward 1 ${timescale === "5y" ? "5-year interval" : timescale === "10y" ? "10-year interval" : timescale.replace("ly", "")}`}
                >
                  <button
                    type="button"
                    onClick={() => handleStep(-1)}
                    aria-label="Previous time interval"
                    className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>

                <Tooltip
                  position="bottom"
                  align="center"
                  content={
                    stepsInBounds <= 1
                      ? "Widen the Start–End range or choose a finer timescale to animate"
                      : isPlaying
                      ? "Pause timeline animation"
                      : "Play animated fire spread from current date"
                  }
                >
                  <button
                    type="button"
                    onClick={handleTogglePlay}
                    disabled={stepsInBounds <= 1}
                    aria-label={isPlaying ? "Pause timeline" : "Play timeline"}
                    className={`p-1.5 rounded-md transition-all ${
                      stepsInBounds <= 1
                        ? "text-slate-600 cursor-not-allowed"
                        : isPlaying
                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/50 shadow-sm"
                        : "text-emerald-400 hover:text-emerald-300 hover:bg-slate-800"
                    }`}
                  >
                    {isPlaying ? (
                      <Pause className="w-3.5 h-3.5" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                  </button>
                </Tooltip>

                <Tooltip
                  position="bottom"
                  align="center"
                  content={`Step forward 1 ${timescale === "5y" ? "5-year interval" : timescale === "10y" ? "10-year interval" : timescale.replace("ly", "")}`}
                >
                  <button
                    type="button"
                    onClick={() => handleStep(1)}
                    aria-label="Next time interval"
                    className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </Tooltip>

                {/* Compact Speed Cycle Pill */}
                <Tooltip
                  position="bottom"
                  align="center"
                  content="Cycle playback speed (1x / 2x / 4x)"
                >
                  <button
                    type="button"
                    onClick={handleCycleSpeed}
                    className="ml-0.5 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 hover:border-slate-700 text-[11px] font-mono font-semibold text-slate-300 hover:text-sky-300 transition-colors"
                  >
                    {playbackSpeed}x
                  </button>
                </Tooltip>
              </div>

              {/* Active Viewing Slice Pill (fixed width prevents wrapping jumps across Daily/Weekly/Monthly) */}
              <div
                title={`Viewing interval: ${activeSlice.label}`}
                className="w-[116px] flex items-center justify-center gap-1.5 border-l border-slate-800 px-2 py-1.5 text-[11px] font-mono text-amber-300 shrink-0"
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                    isPlaying
                      ? "bg-amber-400 animate-ping"
                      : "bg-sky-400"
                  }`}
                />
                <span className="truncate">{activeSlice.shortLabel}</span>
              </div>
            </div>

            {/* Playback Loop Range Date Pickers */}
            <Tooltip
              position="bottom"
              align="center"
              content="Sets the Start and End date boundaries for stepping and looping playback."
            >
              <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-xs shrink-0">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openDatePicker(startDateInputRef)}
                    title="Open playback start date calendar"
                    aria-label="Open playback start date calendar"
                    className="text-slate-400 hover:text-sky-400 transition-colors p-0.5 rounded hover:bg-slate-800/70"
                  >
                    <Calendar className="w-3.5 h-3.5 shrink-0" />
                  </button>
                  <input
                    ref={startDateInputRef}
                    type="date"
                    value={boundsStart}
                    min={dataBounds.min}
                    max={boundsEnd}
                    onChange={(e) => {
                      const nextStart = e.target.value;
                      if (!nextStart) return;
                      setBoundsStart(nextStart);
                      setCursorDate((prev) =>
                        clampDate(prev, nextStart, boundsEnd)
                      );
                    }}
                    className="custom-date-input bg-transparent text-slate-200 font-sans tabular-nums text-[11px] focus:outline-none w-[96px]"
                  />
                </div>

                <span className="text-slate-500 select-none">→</span>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openDatePicker(endDateInputRef)}
                    title="Open playback end date calendar"
                    aria-label="Open playback end date calendar"
                    className="text-slate-400 hover:text-sky-400 transition-colors p-0.5 rounded hover:bg-slate-800/70"
                  >
                    <Calendar className="w-3.5 h-3.5 shrink-0" />
                  </button>
                  <input
                    ref={endDateInputRef}
                    type="date"
                    value={boundsEnd}
                    min={boundsStart}
                    max={dataBounds.max}
                    onChange={(e) => {
                      const nextEnd = e.target.value;
                      if (!nextEnd) return;
                      setBoundsEnd(nextEnd);
                      setCursorDate((prev) =>
                        clampDate(prev, boundsStart, nextEnd)
                      );
                    }}
                    className="custom-date-input bg-transparent text-slate-200 font-sans tabular-nums text-[11px] focus:outline-none w-[96px]"
                  />
                </div>
              </div>
            </Tooltip>

            {/* Sensor Mode Segmented Control with Tooltips */}
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-1 text-xs shrink-0">
              <Tooltip
                position="bottom"
                align="right"
                content="Combines MODIS (1 km resolution) and VIIRS (375 m resolution) satellite records into a unified, calibrated timeline without double-counting."
              >
                <button
                  type="button"
                  onClick={() => setSensorMode("harmonized")}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md font-semibold transition-all whitespace-nowrap ${
                    sensorMode === "harmonized"
                      ? "bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Harmonized</span>
                </button>
              </Tooltip>

              <Tooltip
                position="bottom"
                align="right"
                content="Uncalibrated detections from NASA's MODIS sensors (1 km spatial resolution, active since 2000). Best suited for tracking medium-to-large fires over multi-decade periods."
              >
                <button
                  type="button"
                  onClick={() => setSensorMode("modis")}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-all whitespace-nowrap ${
                    sensorMode === "modis"
                      ? "bg-sky-600 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Satellite className="w-3.5 h-3.5" />
                  <span>Raw MODIS</span>
                </button>
              </Tooltip>

              <Tooltip
                position="bottom"
                align="right"
                content="Uncalibrated detections from VIIRS sensors (375 m spatial resolution, active since 2012). Captures smaller and cooler fires due to its sharper pixel resolution."
              >
                <button
                  type="button"
                  onClick={() => setSensorMode("viirs")}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md font-medium transition-all whitespace-nowrap ${
                    sensorMode === "viirs"
                      ? "bg-emerald-600 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Radio className="w-3.5 h-3.5" />
                  <span>Raw VIIRS</span>
                </button>
              </Tooltip>
            </div>
          </div>
        </div>
      </header>

      {/* Error Banner if API unreachable */}
      {errorMsg && (
        <div className="bg-rose-950/90 border-b border-rose-700 px-4 py-2 text-xs text-rose-200 flex items-center justify-between">
          <span>API Warning: {errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="underline hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1800px] w-full mx-auto px-4 py-3 flex flex-col gap-3">
        {/* KPI Summary Ribbon */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
          {/* Card 1: Active Hotspots in Current Slice */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-medium">
                <span>Active Hotspots</span>
                <InfoTooltip
                  position="bottom"
                  align="left"
                  content="Total number of active fire detections recorded within the selected area and current viewing time slice."
                />
              </div>
              <div className="text-lg font-bold text-amber-400 font-mono">
                {kpiStats.totalFires.toLocaleString()}
              </div>
            </div>
            <Flame className="w-5 h-5 text-amber-500/70 shrink-0" />
          </div>

          {/* Card 2: Active Fire Zones */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-medium">
                <span>Active Fire Zones</span>
                <InfoTooltip
                  position="bottom"
                  align="center"
                  content="Number of distinct geographic grid zones (~0.74 km² each) where active burning was detected during the current viewing slice."
                />
              </div>
              <div className="text-lg font-bold text-sky-400 font-mono">
                {kpiStats.activeZoneCount.toLocaleString()}
              </div>
            </div>
            <Hexagon className="w-5 h-5 text-sky-500/70 shrink-0" />
          </div>

          {/* Card 3: Mean Radiative Power */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-medium">
                <span>Mean Radiative Power</span>
                <InfoTooltip
                  position="bottom"
                  align="center"
                  content="Average heat energy released by detected fires in the current slice, measured in Megawatts (MW). Higher values indicate more intense burning."
                />
              </div>
              <div className="text-lg font-bold text-orange-400 font-mono">
                {kpiStats.avgFrp.toFixed(1)}{" "}
                <span className="text-xs font-normal text-slate-400">MW</span>
              </div>
            </div>
            <Zap className="w-5 h-5 text-orange-500/70 shrink-0" />
          </div>

          {/* Card 4: Critical Fire Season */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-medium">
                <span>Critical Fire Season</span>
                <InfoTooltip
                  position="bottom"
                  align="center"
                  content="The peak calendar window (Month-Day) when historical fire activity consistently reaches its highest levels in the selected area."
                />
              </div>
              <div className="text-base font-bold text-emerald-400 font-mono">
                {calendarSummary.critical_season_start} →{" "}
                {calendarSummary.critical_season_end}
              </div>
            </div>
            <CalendarRange className="w-5 h-5 text-emerald-500/70 shrink-0" />
          </div>

          {/* Card 5: Anomaly Weeks */}
          <div className="col-span-2 md:col-span-1 bg-slate-900/90 border border-slate-800 rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-medium">
                <span>Anomaly Weeks</span>
                <InfoTooltip
                  position="bottom"
                  align="right"
                  content="Number of weeks inside your selected playback range where burning activity unusually exceeded the seasonal average (statistical Z-score > 2.0)."
                />
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold text-rose-400 font-mono">
                  {kpiStats.anomalyWeeks}
                </span>
                {kpiStats.peakAnomaly && (
                  <span className="text-[11px] text-slate-400 font-mono">
                    Peak: {kpiStats.peakAnomaly.date}
                  </span>
                )}
              </div>
            </div>
            <AlertOctagon className="w-5 h-5 text-rose-500/70 shrink-0" />
          </div>
        </div>

        {/* Workspace: full-width Interactive Map on top, Calendar & Trend side by side below */}
        <div className="flex flex-col gap-3">
          {/* Top Row: Interactive Map UI (full width) */}
          <div className="h-[460px] lg:h-[60vh] lg:min-h-[480px] lg:max-h-[760px] flex flex-col">
            <MapView
              hexData={mapHexData}
              dailyStudyAreaOnly={dailyStudyAreaOnly}
              aoi={aoi}
              hasCustomAoi={hasCustomAoi}
              onChangeAoi={handleCustomAoi}
              onResetAoi={handleResetAoi}
              onViewChange={handleMapViewChange}
              sensorMode={sensorMode}
              activeSliceLabel={activeSlice.label}
              loading={loadingMap || loadingCalendar}
            />
          </div>

          {/* Bottom Row: Burning Activity Calendar | Burning Activity Trend */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="h-[360px]">
              <CalendarHeatmap
                timeSeries={calendarSeries}
                summary={calendarSummary}
                sensorMode={sensorMode}
                highlightedDateRange={highlightedDateRange}
                onJumpToDate={handleJumpToDate}
              />
            </div>

            <div className="h-[360px]">
              <ClimatologyChart
                trendPoints={trendSeries}
                timescale={timescale}
                activeSliceKey={activeSlice.key}
                onJumpToDate={handleJumpToDate}
                loading={loadingTrend}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
