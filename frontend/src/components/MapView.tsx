import React, { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { StyleSpecification } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { IconLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import * as h3 from "h3-js";
import {
  Box,
  Check,
  Compass,
  Earth,
  Globe,
  Layers,
  Map as MapIcon,
  MousePointer,
  Pentagon,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { GeoJSONPolygon, SensorMode, SpatialHexDatum } from "../types/api";

const DARK_MATTER_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    "esri-satellite": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Tiles &copy; Esri",
    },
    // Esri's reference overlay (place names + borders) pairs with World Imagery
    // and needs no API key. The previous Carto raster label tiles now render an
    // "API KEY REQUIRED" watermark.
    "esri-labels": {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Labels &copy; Esri",
    },
  },
  layers: [
    {
      id: "esri-satellite-layer",
      type: "raster",
      source: "esri-satellite",
      minzoom: 0,
      maxzoom: 19,
    },
    {
      id: "esri-labels-layer",
      type: "raster",
      source: "esri-labels",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

type DrawMode = "none" | "bbox" | "polygon";
type MapProjection = "globe" | "flat";

// Camera the map settles on: Malaysia and its neighbours.
const HOME_CENTER: [number, number] = [109.2, 3.8];
const HOME_ZOOM = 5.3;
// Zoom the page opens at, so the whole globe is visible before flying in.
const INTRO_ZOOM = 1.4;

// Apply the chosen projection (and a soft atmosphere halo for the globe).
// MapLibre resets both whenever a new style is loaded, so this runs on every
// "style.load" as well as when the user flips the Globe / Flat switch.
function projectionSpec(
  projection: MapProjection
): NonNullable<StyleSpecification["projection"]> {
  return { type: projection === "globe" ? "globe" : "mercator" };
}

function skySpec(
  projection: MapProjection
): NonNullable<StyleSpecification["sky"]> {
  return {
    "atmosphere-blend":
      projection === "globe"
        ? ["interpolate", ["linear"], ["zoom"], 0, 0.8, 4.5, 0.6, 6.5, 0]
        : 0,
  };
}

function applyProjection(map: maplibregl.Map, projection: MapProjection) {
  map.setProjection(projectionSpec(projection));
  map.setSky(skySpec(projection));
}

// Switch dynamically to MapLibre's GPU heatmap layer when visible cells exceed this threshold.
const HEATMAP_CELL_THRESHOLD = 1200;
const HEATMAP_SOURCE_ID = "fire-heatmap-source";
const HEATMAP_LAYER_ID = "fire-heatmap-layer";
const HEATMAP_HIT_LAYER_ID = "fire-heatmap-hit";
const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: "FeatureCollection",
  features: [],
};

// Bounded centroid cache so H3 cell-to-latlng isn't recomputed on every tick.
const CELL_POSITION_CACHE = new Map<string, [number, number]>();
function getCellPosition(h3Index: string): [number, number] | null {
  const cached = CELL_POSITION_CACHE.get(h3Index);
  if (cached) return cached;
  try {
    const [lat, lon] = h3.cellToLatLng(h3Index);
    const pos: [number, number] = [lon, lat];
    if (CELL_POSITION_CACHE.size >= 200000) {
      CELL_POSITION_CACHE.clear();
    }
    CELL_POSITION_CACHE.set(h3Index, pos);
    return pos;
  } catch {
    return null;
  }
}

function quantizeCoord(val: number, step: number, fn: (x: number) => number): number {
  return fn(val / step) * step;
}

function computeSpatialView(map: maplibregl.Map): {
  maxResolution: number;
  viewportBbox: [number, number, number, number] | null;
} {
  const zoom = map.getZoom();
  // Upgrade H3 resolution early enough that adjacent cell spacing stays <= ~15px
  // on screen, allowing the GPU heatmap radius to blend cells seamlessly.
  let maxResolution = 8;
  if (zoom < 1.8) maxResolution = 2;
  else if (zoom < 3.4) maxResolution = 3;
  else if (zoom < 4.7) maxResolution = 4;
  else if (zoom < 5.9) maxResolution = 5;
  else if (zoom < 7.2) maxResolution = 6;

  if (zoom < 3.0) {
    return { maxResolution, viewportBbox: null };
  }

  const bounds = map.getBounds();
  const rawWest = bounds.getWest();
  const rawEast = bounds.getEast();
  const rawSouth = bounds.getSouth();
  const rawNorth = bounds.getNorth();
  const lonSpan = rawWest <= rawEast ? rawEast - rawWest : 360 - (rawWest - rawEast);
  if (lonSpan >= 280) {
    return { maxResolution, viewportBbox: null };
  }

  const latSpan = Math.max(1, rawNorth - rawSouth);
  const lonPad = Math.max(2, lonSpan * 0.4);
  const latPad = Math.max(2, latSpan * 0.4);
  const step = zoom >= 7.0 ? 1 : 2;

  const south = Math.max(-90, quantizeCoord(rawSouth - latPad, step, Math.floor));
  const north = Math.min(90, quantizeCoord(rawNorth + latPad, step, Math.ceil));

  if (rawWest <= rawEast) {
    const west = Math.max(-180, quantizeCoord(rawWest - lonPad, step, Math.floor));
    const east = Math.min(180, quantizeCoord(rawEast + lonPad, step, Math.ceil));
    if (east - west >= 358 && south <= -89 && north >= 89) {
      return { maxResolution, viewportBbox: null };
    }
    return { maxResolution, viewportBbox: [west, south, east, north] };
  }

  return { maxResolution, viewportBbox: null };
}

const H3_SPACING_KM: Record<number, number> = {
  0: 1920,
  1: 725,
  2: 275,
  3: 104,
  4: 39.2,
  5: 14.8,
  6: 5.6,
  7: 2.1,
  8: 0.8,
};

interface HeatmapScale {
  radiusExpr: maplibregl.ExpressionSpecification;
  intensityExpr: maplibregl.ExpressionSpecification;
}

const DEFAULT_HEATMAP_SCALE: HeatmapScale = {
  radiusExpr: ["interpolate", ["linear"], ["zoom"], 1, 18, 5, 24, 9, 14],
  intensityExpr: ["interpolate", ["linear"], ["zoom"], 1, 0.25, 5, 0.3, 9, 0.2],
};

function computeDynamicHeatmapScale(
  cellsInView: SpatialHexDatum[],
  maxScore: number,
  map: maplibregl.Map | null
): HeatmapScale {
  if (!cellsInView.length) return DEFAULT_HEATMAP_SCALE;

  // Detect dominant H3 resolution currently in view so radius/packing track actual cell spacing.
  const resCounts = new Map<number, number>();
  const sampleStep = Math.max(1, Math.floor(cellsInView.length / 200));
  for (let i = 0; i < cellsInView.length; i += sampleStep) {
    try {
      const r = h3.getResolution(cellsInView[i].h3_index);
      resCounts.set(r, (resCounts.get(r) ?? 0) + 1);
    } catch {
      // ignore invalid h3 id
    }
  }
  let sampleRes = 4;
  let bestCount = -1;
  for (const [res, cnt] of resCounts.entries()) {
    if (cnt > bestCount) {
      bestCount = cnt;
      sampleRes = res;
    }
  }

  const anchorZoom = map ? map.getZoom() : HOME_ZOOM;
  const centerLat = map ? map.getCenter().lat : 0;
  const cosLat = Math.max(0.35, Math.cos((centerLat * Math.PI) / 180));
  const spacingKm = H3_SPACING_KM[sampleRes] ?? 39.2;

  const spacingPxAt = (z: number) =>
    spacingKm / ((78.2715 / Math.pow(2, z)) * cosLat);
  // Keep radius large enough (~2.05x grid spacing) to eliminate checkering,
  // but tightly bounded [10..34] px so fine geographic detail stays crisp.
  const radiusAt = (z: number) =>
    Math.max(10, Math.min(34, spacingPxAt(z) * 2.05));

  // Measure real spatial weight accumulation inside a screen-space R x R bin
  // (2πσ² ≈ R² for MapLibre's Gaussian kernel), so intensity auto-scales to avoid whiteout.
  const rAnchor = radiusAt(anchorZoom);
  const degPerPx = 360 / (512 * Math.pow(2, anchorZoom));
  const binLon = Math.max(0.0005, rAnchor * degPerPx);
  const binLat = Math.max(0.0005, binLon * cosLat);
  const bins = new Map<number, number>();

  for (const d of cellsInView) {
    const pos = getCellPosition(d.h3_index);
    if (!pos) continue;
    const weight = Math.min(
      1,
      Math.max(0.08, Math.pow(d.total_fires, 0.45) / maxScore)
    );
    const bx = Math.floor((pos[0] + 180) / binLon);
    const by = Math.floor((pos[1] + 90) / binLat);
    const key = by * 1000000 + bx;
    bins.set(key, (bins.get(key) ?? 0) + weight);
  }

  const binVals = Array.from(bins.values()).sort((a, b) => a - b);
  const maxBinSum = binVals[binVals.length - 1] ?? 1;
  const p98Idx = Math.min(
    binVals.length - 1,
    Math.floor(binVals.length * 0.98)
  );
  const p98BinSum = binVals[p98Idx] ?? maxBinSum;
  const targetPeak = Math.max(0.25, Math.min(maxBinSum * 0.94, p98BinSum * 1.6));
  const anchorIntensity = Math.max(0.025, Math.min(1.3, 0.92 / targetPeak));

  const zLo = Math.max(0.5, Number((anchorZoom - 1.5).toFixed(2)));
  const zMid = Number(Math.max(zLo + 0.25, anchorZoom).toFixed(2));
  const zHi = Number((zMid + 1.5).toFixed(2));

  const packingRatio = (z: number) =>
    Math.pow(radiusAt(z) / Math.max(0.25, spacingPxAt(z)), 2);
  const midPacking = packingRatio(zMid);
  const intensityAt = (z: number) =>
    Number(
      Math.max(
        0.02,
        Math.min(1.4, anchorIntensity * (midPacking / Math.max(0.05, packingRatio(z))))
      ).toFixed(4)
    );

  return {
    radiusExpr: [
      "interpolate",
      ["linear"],
      ["zoom"],
      zLo,
      Number(radiusAt(zLo).toFixed(1)),
      zMid,
      Number(radiusAt(zMid).toFixed(1)),
      zHi,
      Number(radiusAt(zHi).toFixed(1)),
    ],
    intensityExpr: [
      "interpolate",
      ["linear"],
      ["zoom"],
      zLo,
      intensityAt(zLo),
      zMid,
      intensityAt(zMid),
      zHi,
      intensityAt(zHi),
    ],
  };
}

function ensureHeatmapLayers(
  map: maplibregl.Map,
  data: GeoJSON.FeatureCollection<GeoJSON.Point>,
  visible: boolean,
  scale: HeatmapScale
) {
  if (!map.isStyleLoaded()) return;

  if (!map.getSource(HEATMAP_SOURCE_ID)) {
    map.addSource(HEATMAP_SOURCE_ID, {
      type: "geojson",
      data,
    });
  } else {
    const src = map.getSource(HEATMAP_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    src?.setData(data);
  }

  const visibility = visible ? "visible" : "none";

  if (!map.getLayer(HEATMAP_LAYER_ID)) {
    map.addLayer({
      id: HEATMAP_LAYER_ID,
      type: "heatmap",
      source: HEATMAP_SOURCE_ID,
      layout: { visibility },
      paint: {
        "heatmap-weight": ["coalesce", ["get", "weight"], 0.12],
        "heatmap-intensity": scale.intensityExpr,
        "heatmap-color": [
          "interpolate",
          ["linear"],
          ["heatmap-density"],
          0,
          "rgba(0, 0, 0, 0)",
          0.03,
          "rgba(245, 158, 11, 0.16)",
          0.16,
          "rgba(253, 224, 71, 0.46)",
          0.38,
          "rgba(251, 146, 60, 0.72)",
          0.64,
          "rgba(239, 68, 68, 0.86)",
          0.88,
          "rgba(220, 38, 38, 0.94)",
          0.97,
          "rgba(251, 113, 133, 0.98)",
          1.0,
          "rgba(255, 244, 214, 1)",
        ],
        "heatmap-radius": scale.radiusExpr,
        "heatmap-opacity": 0.9,
      },
    });
  } else {
    map.setLayoutProperty(HEATMAP_LAYER_ID, "visibility", visibility);
    if (visible) {
      map.setPaintProperty(HEATMAP_LAYER_ID, "heatmap-radius", scale.radiusExpr);
      map.setPaintProperty(
        HEATMAP_LAYER_ID,
        "heatmap-intensity",
        scale.intensityExpr
      );
    }
  }

  if (!map.getLayer(HEATMAP_HIT_LAYER_ID)) {
    map.addLayer({
      id: HEATMAP_HIT_LAYER_ID,
      type: "circle",
      source: HEATMAP_SOURCE_ID,
      layout: { visibility },
      paint: {
        "circle-radius": 14,
        "circle-opacity": 0,
        "circle-stroke-opacity": 0,
      },
    });
  } else {
    map.setLayoutProperty(HEATMAP_HIT_LAYER_ID, "visibility", visibility);
  }
}

interface FireBeaconCluster {
  id: string;
  h3_index: string;
  position: [number, number];
  total_fires: number;
  mean_frp: number;
  zone_count: number;
}

interface MapViewProps {
  hexData: SpatialHexDatum[];
  aoi: GeoJSONPolygon;
  hasCustomAoi: boolean;
  onChangeAoi: (newAoi: GeoJSONPolygon) => void;
  onResetAoi: () => void;
  onViewChange?: (view: {
    maxResolution: number;
    viewportBbox: [number, number, number, number] | null;
  }) => void;
  sensorMode: SensorMode;
  activeSliceLabel?: string;
  /** Daily view of a dataset whose world outside the study area is weekly. */
  dailyStudyAreaOnly?: boolean;
  loading: boolean;
}

// Soft round "ember" sprite: opaque at the centre, fading smoothly to nothing.
// Drawn once on a canvas and tinted per fire by the IconLayer (mask: true).
const GLOW_SPRITE_SIZE = 128;
const GLOW_ICON_MAPPING = {
  glow: {
    x: 0,
    y: 0,
    width: GLOW_SPRITE_SIZE,
    height: GLOW_SPRITE_SIZE,
    mask: true,
  },
};

function createGlowSprite(): string {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_SPRITE_SIZE;
  canvas.height = GLOW_SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const r = GLOW_SPRITE_SIZE / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.12, "rgba(255,255,255,0.85)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.42)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.14)");
  gradient.addColorStop(0.8, "rgba(255,255,255,0.03)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
  return canvas.toDataURL();
}

// Pulsing heat rings (zoomed-in view): each fire sends out thin rings that
// widen and fade, like ripples. Three rings per fire, evenly staggered.
const HEAT_RINGS_PER_FIRE = 3;
// With thousands of adjacent burning cells the rings would merge into noise,
// so only the strongest fires pulse; every fire still gets its hot core dot.
const MAX_PULSING_FIRES = 500;

// Additive light for the rings. Unlike the glow sprites these lie on the
// surface, so the globe's back-face culling must stay on to hide the far side.
const HEAT_RING_PARAMETERS = {
  depthWriteEnabled: false,
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

// Light adds up where glows overlap, the way real firelight does.
const ADDITIVE_GLOW_PARAMETERS = {
  // deck.gl's globe view culls back faces, which drops camera-facing sprites.
  cullMode: "none",
  depthWriteEnabled: false,
  blend: true,
  blendColorOperation: "add",
  blendColorSrcFactor: "src-alpha",
  blendColorDstFactor: "one",
  blendAlphaOperation: "add",
  blendAlphaSrcFactor: "one",
  blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

// Stable 0..2π phase per fire so each one flickers on its own rhythm.
function flickerPhase(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 6283) / 1000;
}

// Gentle, irregular breathing of a flame: two sine waves out of step.
function flickerFactor(timeSec: number, phase: number): number {
  return (
    1 +
    0.1 * Math.sin(timeSec * 2.3 + phase) +
    0.06 * Math.sin(timeSec * 5.9 + phase * 1.7)
  );
}

function getFireColor(
  fires: number,
  maxFires: number
): [number, number, number, number] {
  const ratio = Math.min(1, Math.sqrt(fires / Math.max(1, maxFires * 0.75)));
  if (ratio < 0.25) {
    return [253, 224, 71, 200];
  } else if (ratio < 0.5) {
    return [251, 146, 60, 215];
  } else if (ratio < 0.75) {
    return [239, 68, 68, 230];
  } else {
    return [225, 29, 72, 245];
  }
}

export const MapView: React.FC<MapViewProps> = ({
  hexData,
  aoi,
  hasCustomAoi,
  onChangeAoi,
  onResetAoi,
  onViewChange,
  sensorMode,
  activeSliceLabel,
  dailyStudyAreaOnly = false,
  loading,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);

  const [basemap, setBasemap] = useState<"dark" | "satellite">("dark");
  const [extruded3D, setExtruded3D] = useState<boolean>(true);
  const [projection, setProjection] = useState<MapProjection>("globe");
  const projectionRef = useRef<MapProjection>(projection);
  projectionRef.current = projection;
  const [currentZoom, setCurrentZoom] = useState<number>(INTRO_ZOOM);
  const [drawMode, setDrawMode] = useState<DrawMode>("none");
  const [draftVertices, setDraftVertices] = useState<[number, number][]>([]);
  const [cursorLonLat, setCursorLonLat] = useState<[number, number] | null>(
    null
  );
  const [hoveredHex, setHoveredHex] = useState<{
    datum: SpatialHexDatum | FireBeaconCluster;
    x: number;
    y: number;
  } | null>(null);

  // Clock (seconds) that drives the ember flicker; stays 0 when motion is reduced.
  const [flickerTime, setFlickerTime] = useState<number>(0);
  // Bumped whenever the camera settles, so far-side glow hiding stays current.
  const [viewTick, setViewTick] = useState<number>(0);
  const glowSprite = useMemo(() => createGlowSprite(), []);

  const drawModeRef = useRef<DrawMode>(drawMode);
  drawModeRef.current = drawMode;
  const draftVerticesRef = useRef<[number, number][]>(draftVertices);
  draftVerticesRef.current = draftVertices;
  const cursorLonLatRef = useRef<[number, number] | null>(cursorLonLat);
  cursorLonLatRef.current = cursorLonLat;
  const isDraggingBoxRef = useRef<boolean>(false);
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  const maxFires = useMemo(() => {
    if (!hexData.length) return 100;
    return Math.max(...hexData.map((d) => d.total_fires), 10);
  }, [hexData]);

  // Filter dataset to points inside (or near) the current viewport so zoomed-in
  // views switch cleanly from heatmap -> discrete fire dots once sparse enough.
  const cellsInView = useMemo(() => {
    const map = mapRef.current;
    if (!map) return hexData;
    const bounds = map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const lonSpan = west <= east ? east - west : 360 - (west - east);
    if (lonSpan >= 280) return hexData;
    const spansAntimeridian = west > east;
    return hexData.filter((d) => {
      const pos = getCellPosition(d.h3_index);
      if (!pos) return false;
      const [lon, lat] = pos;
      if (lat < south - 1.5 || lat > north + 1.5) return false;
      return spansAntimeridian
        ? lon >= west - 1.5 || lon <= east + 1.5
        : lon >= west - 1.5 && lon <= east + 1.5;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hexData, viewTick]);

  // Dynamic rendering mode: dense viewport -> GPU heatmap, small dataset -> dots.
  const useHeatmapMode = cellsInView.length > HEATMAP_CELL_THRESHOLD;

  const maxHeatScore = useMemo(
    () => Math.max(1, Math.pow(maxFires, 0.45)),
    [maxFires]
  );

  const heatmapGeoJson = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(() => {
    if (!useHeatmapMode) return EMPTY_FEATURE_COLLECTION;
    const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const d of hexData) {
      const pos = getCellPosition(d.h3_index);
      if (!pos) continue;
      // Sublinear power curve preserves contrast between moderate fire belts
      // and peak hotspots without flattening dense clusters.
      const weight = Math.min(
        1,
        Math.max(0.08, Math.pow(d.total_fires, 0.45) / maxHeatScore)
      );
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: pos,
        },
        properties: {
          h3_index: d.h3_index,
          total_fires: d.total_fires,
          mean_frp: d.mean_frp,
          weight,
        },
      });
    }
    return {
      type: "FeatureCollection",
      features,
    };
  }, [hexData, maxHeatScore, useHeatmapMode]);

  const heatmapScale = useMemo<HeatmapScale>(() => {
    if (!useHeatmapMode) return DEFAULT_HEATMAP_SCALE;
    return computeDynamicHeatmapScale(cellsInView, maxHeatScore, mapRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellsInView, maxHeatScore, viewTick, useHeatmapMode]);

  const heatmapGeoJsonRef = useRef(heatmapGeoJson);
  heatmapGeoJsonRef.current = heatmapGeoJson;
  const heatmapScaleRef = useRef(heatmapScale);
  heatmapScaleRef.current = heatmapScale;
  const useHeatmapModeRef = useRef(useHeatmapMode);
  useHeatmapModeRef.current = useHeatmapMode;

  // Determine appropriate H3 aggregation resolution for current zoom level
  const clusterResolution = useMemo(() => {
    if (currentZoom < 4.0) return 4; // Continental scale: ~1,770 km² parent zones
    if (currentZoom < 5.2) return 5; // Regional scale: ~252 km² parent zones
    if (currentZoom < 6.4) return 6; // Sub-regional scale: ~36 km² parent zones
    return 8; // Full Res-8 detail
  }, [currentZoom]);

  // Dynamic hierarchical H3 dot/beacon clustering across all zoom levels when in dot mode
  const { clusteredBeacons, maxClusterFires } = useMemo(() => {
    if (useHeatmapMode) {
      return { clusteredBeacons: [] as FireBeaconCluster[], maxClusterFires: 100 };
    }

    if (clusterResolution >= 8) {
      const items: FireBeaconCluster[] = cellsInView.map((d) => {
        const pos = getCellPosition(d.h3_index) ?? [100.0, 3.0];
        return {
          id: d.h3_index,
          h3_index: d.h3_index,
          position: pos,
          total_fires: d.total_fires,
          mean_frp: d.mean_frp,
          zone_count: 1,
        };
      });
      const maxF = items.length
        ? Math.max(...items.map((i) => i.total_fires), 10)
        : 100;
      return { clusteredBeacons: items, maxClusterFires: maxF };
    }

    const clusterMap = new Map<
      string,
      { total_fires: number; weighted_frp: number; zone_count: number }
    >();

    for (const d of cellsInView) {
      let parentId = d.h3_index;
      try {
        if (h3.getResolution(d.h3_index) > clusterResolution) {
          parentId = h3.cellToParent(d.h3_index, clusterResolution);
        }
      } catch {
        parentId = d.h3_index;
      }

      let c = clusterMap.get(parentId);
      if (!c) {
        c = { total_fires: 0, weighted_frp: 0, zone_count: 0 };
        clusterMap.set(parentId, c);
      }
      c.total_fires += d.total_fires;
      c.weighted_frp += d.mean_frp * d.total_fires;
      c.zone_count += 1;
    }

    const items: FireBeaconCluster[] = Array.from(clusterMap.entries()).map(
      ([parentId, c]) => {
        const pos = getCellPosition(parentId) ?? [100.0, 3.0];
        return {
          id: parentId,
          h3_index: parentId,
          position: pos,
          total_fires: c.total_fires,
          mean_frp:
            Math.round(
              (c.weighted_frp / Math.max(1, c.total_fires)) * 10
            ) / 10,
          zone_count: c.zone_count,
        };
      }
    );

    const maxF = items.length
      ? Math.max(...items.map((i) => i.total_fires), 10)
      : 100;
    return { clusteredBeacons: items, maxClusterFires: maxF };
  }, [cellsInView, clusterResolution, useHeatmapMode]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: DARK_MATTER_STYLE,
      center: HOME_CENTER,
      zoom: INTRO_ZOOM,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      // Show a single world: no repeated copies when zoomed out on a wide map.
      renderWorldCopies: false,
    });

    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "bottom-right"
    );

    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
    });
    map.addControl(overlay as unknown as maplibregl.IControl);

    map.on("zoom", () => {
      setCurrentZoom(map.getZoom());
    });

    map.on("moveend", () => {
      setViewTick((t) => t + 1);
      onViewChangeRef.current?.(computeSpatialView(map));
    });

    // Re-apply the projection and GPU heatmap layers after any style load.
    map.on("style.load", () => {
      applyProjection(map, projectionRef.current);
      ensureHeatmapLayers(
        map,
        heatmapGeoJsonRef.current,
        useHeatmapModeRef.current,
        heatmapScaleRef.current
      );
    });

    map.on("mousemove", HEATMAP_HIT_LAYER_ID, (e) => {
      if (drawModeRef.current !== "none" || !useHeatmapModeRef.current) return;
      const feat = e.features?.[0];
      if (!feat?.properties) return;
      map.getCanvas().style.cursor = "pointer";
      setHoveredHex({
        datum: {
          h3_index: String(feat.properties.h3_index || ""),
          total_fires: Number(feat.properties.total_fires || 0),
          mean_frp: Number(feat.properties.mean_frp || 0),
        },
        x: e.point.x,
        y: e.point.y,
      });
    });

    map.on("mouseleave", HEATMAP_HIT_LAYER_ID, () => {
      if (drawModeRef.current === "none") {
        map.getCanvas().style.cursor = "";
      }
      setHoveredHex(null);
    });

    map.on("click", HEATMAP_HIT_LAYER_ID, (e) => {
      if (drawModeRef.current !== "none" || !useHeatmapModeRef.current) return;
      const feat = e.features?.[0];
      if (!feat || feat.geometry.type !== "Point") return;
      const coords = feat.geometry.coordinates as [number, number];
      const z = map.getZoom();
      map.flyTo({
        center: coords,
        zoom: Math.max(z, Math.min(10.5, z + 2.2)),
        duration: 1100,
      });
    });

    // Opening move: show the whole globe, then fly in to the region.
    map.once("load", () => {
      ensureHeatmapLayers(
        map,
        heatmapGeoJsonRef.current,
        useHeatmapModeRef.current,
        heatmapScaleRef.current
      );
      map.flyTo({
        center: HOME_CENTER,
        zoom: HOME_ZOOM,
        pitch: projectionRef.current === "flat" ? 0 : 36,
        duration: 3200,
      });
    });

    const toLonLat = (lngLat: maplibregl.LngLat): [number, number] | null => {
      const wrapped = lngLat.wrap();
      if (!Number.isFinite(wrapped.lng) || !Number.isFinite(wrapped.lat)) {
        return null;
      }
      return [
        Number(wrapped.lng.toFixed(4)),
        Number(wrapped.lat.toFixed(4)),
      ];
    };

    const finalizeBoxDrag = (endPt: [number, number] | null) => {
      if (drawModeRef.current !== "bbox" || !isDraggingBoxRef.current) return;
      isDraggingBoxRef.current = false;

      const currentPts = draftVerticesRef.current;
      if (currentPts.length === 0 || !endPt) {
        setDraftVertices([]);
        return;
      }

      const [lon1, lat1] = currentPts[0];
      const [lon2, lat2] = endPt;
      const minLon = Math.min(lon1, lon2);
      const maxLon = Math.max(lon1, lon2);
      const minLat = Math.min(lat1, lat2);
      const maxLat = Math.max(lat1, lat2);

      if (maxLon - minLon > 0.01 && maxLat - minLat > 0.01) {
        onChangeAoi({
          type: "Polygon",
          coordinates: [
            [
              [minLon, minLat],
              [maxLon, minLat],
              [maxLon, maxLat],
              [minLon, maxLat],
              [minLon, minLat],
            ],
          ],
        });
        setDraftVertices([]);
        setCursorLonLat(null);
        setDrawMode("none");
      } else {
        // Ignore accidental single click without dragging; stay in Draw Box mode
        setDraftVertices([]);
      }
    };

    map.on("mousedown", (e) => {
      if (drawModeRef.current === "bbox" && e.originalEvent.button === 0) {
        e.preventDefault();
        const pt = toLonLat(e.lngLat);
        if (!pt) return;
        isDraggingBoxRef.current = true;
        setDraftVertices([pt]);
        setCursorLonLat(pt);
      }
    });

    map.on("mousemove", (e) => {
      if (drawModeRef.current !== "none") {
        const pt = toLonLat(e.lngLat);
        if (pt) {
          setCursorLonLat(pt);
        }
      }
    });

    map.on("mouseup", (e) => {
      if (drawModeRef.current === "bbox" && isDraggingBoxRef.current) {
        finalizeBoxDrag(toLonLat(e.lngLat));
      }
    });

    const handleWindowMouseUp = () => {
      if (drawModeRef.current === "bbox" && isDraggingBoxRef.current) {
        finalizeBoxDrag(cursorLonLatRef.current);
      }
    };
    window.addEventListener("mouseup", handleWindowMouseUp);

    map.on("click", (e) => {
      const mode = drawModeRef.current;
      if (mode !== "polygon") return;

      const pt = toLonLat(e.lngLat);
      if (!pt) return;
      setDraftVertices([...draftVerticesRef.current, pt]);
    });

    mapRef.current = map;
    deckOverlayRef.current = overlay;

    return () => {
      window.removeEventListener("mouseup", handleWindowMouseUp);
      map.remove();
      mapRef.current = null;
      deckOverlayRef.current = null;
    };
  }, [onChangeAoi]);

  const handleToggleBasemap = (target: "dark" | "satellite") => {
    setBasemap(target);
    if (!mapRef.current) return;
    // Carry the current projection into the new style, so the map never drops
    // back to a flat map (and shifts the camera) while the basemap is swapping.
    const current = projectionRef.current;
    mapRef.current.setStyle(
      target === "dark" ? DARK_MATTER_STYLE : SATELLITE_STYLE,
      {
        transformStyle: (_previous, next) => ({
          ...next,
          projection: projectionSpec(current),
          sky: skySpec(current),
        }),
      }
    );
  };

  const handleToggleProjection = (target: MapProjection) => {
    setProjection(target);
    if (target === "flat") {
      setExtruded3D(false);
    }
    if (mapRef.current) {
      applyProjection(mapRef.current, target);
      if (target === "flat") {
        // Reset tilt and bearing so "Flat" shows an immediate top-down view.
        mapRef.current.easeTo({ pitch: 0, bearing: 0, duration: 500 });
      }
    }
  };

  const handleToggle3D = () => {
    const next = !extruded3D;
    setExtruded3D(next);
    if (mapRef.current) {
      mapRef.current.easeTo({ pitch: next ? 38 : 0, duration: 600 });
    }
  };

  const handleFinishPolygon = () => {
    if (draftVertices.length >= 3) {
      const closedRing = [...draftVertices, draftVertices[0]];
      onChangeAoi({
        type: "Polygon",
        coordinates: [closedRing],
      });
    }
    setDraftVertices([]);
    setCursorLonLat(null);
    setDrawMode("none");
  };

  const handleCancelDraw = () => {
    isDraggingBoxRef.current = false;
    setDraftVertices([]);
    setCursorLonLat(null);
    setDrawMode("none");
  };

  // Keyboard shortcut: Escape cancels drawing mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawMode !== "none") {
        handleCancelDraw();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drawMode]);

  // Update canvas cursor and disable pan/zoom interactions while drawing
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    if (drawMode !== "none") {
      setHoveredHex(null);
      map.getCanvas().style.cursor = "crosshair";
      map.dragPan.disable();
      map.boxZoom.disable();
      map.doubleClickZoom.disable();
    } else {
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
    }
  }, [drawMode]);

  // Sync GPU heatmap data, dynamic scale, & visibility when dense mode toggles or data/view updates.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    ensureHeatmapLayers(map, heatmapGeoJson, useHeatmapMode, heatmapScale);
  }, [heatmapGeoJson, useHeatmapMode, heatmapScale]);

  // Animation clock (~16 fps) for the ember flicker and the flames; paused in GPU heatmap mode.
  const fireAnimationActive = hexData.length > 0 && !useHeatmapMode;
  useEffect(() => {
    if (!fireAnimationActive) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      if (now - lastUpdate >= 60) {
        lastUpdate = now;
        setFlickerTime(now / 1000);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fireAnimationActive]);

  // One pulse source per visible fire cell in dot mode, strongest first.
  const heatPoints = useMemo(() => {
    if (useHeatmapMode || !extruded3D || currentZoom < 5.0) return [];
    return cellsInView
      .flatMap((d) => {
        const pos = getCellPosition(d.h3_index);
        if (!pos) return [];
        return [
          {
            id: d.h3_index,
            position: pos,
            total_fires: d.total_fires,
            mean_frp: d.mean_frp,
            // 0..1 offset so neighbouring fires do not pulse in step
            phase: flickerPhase(d.h3_index) / 6.283,
          },
        ];
      })
      .sort((x, y) => y.total_fires - x.total_fires);
  }, [cellsInView, useHeatmapMode, extruded3D, currentZoom]);

  // Only cells inside the current viewport are triangulated as H3 polygons.
  const hexDataInView = useMemo(() => {
    if (useHeatmapMode || currentZoom < 5.0) return [] as SpatialHexDatum[];
    return cellsInView;
  }, [cellsInView, useHeatmapMode, currentZoom]);

  // Only fires inside the current view pulse, re-checked whenever the camera
  // settles. The map holds the whole world's fires, so without this the
  // strongest 500 on Earth would take every ring and a zoomed-in region
  // would get none.
  const heatPointsInView = useMemo(() => {
    const map = mapRef.current;
    if (!map || !heatPoints.length) return heatPoints;
    const bounds = map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const spansAntimeridian = west > east;
    return heatPoints.filter(({ position: [lon, lat] }) => {
      if (lat < south || lat > north) return false;
      return spansAntimeridian
        ? lon >= west || lon <= east
        : lon >= west && lon <= east;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatPoints, viewTick]);

  // Ring size and speed are judged against the strongest fire in view, so a
  // quiet region still shows which of its own fires are the bigger ones.
  const maxFiresInView = Math.max(1, heatPointsInView[0]?.total_fires ?? 1);

  // The rings themselves: each pulsing fire repeated once per staggered ring.
  const heatRings = useMemo(
    () =>
      heatPointsInView.slice(0, MAX_PULSING_FIRES).flatMap((d) =>
        Array.from({ length: HEAT_RINGS_PER_FIRE }, (_, ring) => ({
          ...d,
          ringOffset: ring / HEAT_RINGS_PER_FIRE,
        }))
      ),
    [heatPointsInView]
  );

  const draftPolygonCoords = useMemo(() => {
    if (drawMode === "bbox" && draftVertices.length === 1 && cursorLonLat) {
      const [lon1, lat1] = draftVertices[0];
      const [lon2, lat2] = cursorLonLat;
      const minLon = Math.min(lon1, lon2);
      const maxLon = Math.max(lon1, lon2);
      const minLat = Math.min(lat1, lat2);
      const maxLat = Math.max(lat1, lat2);
      return [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ];
    }
    if (drawMode === "polygon" && draftVertices.length >= 1) {
      const pts = cursorLonLat
        ? [...draftVertices, cursorLonLat]
        : [...draftVertices];
      if (pts.length >= 2) {
        return [...pts, pts[0]];
      }
    }
    return null;
  }, [drawMode, draftVertices, cursorLonLat]);

  useEffect(() => {
    if (!deckOverlayRef.current) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layers: any[] = [];

    // Only draw the blue AOI selection boundary when the user has drawn a custom Box/Polygon
    if (hasCustomAoi) {
      layers.push(
        new PolygonLayer({
          id: "active-aoi-boundary",
          data: [{ polygon: aoi.coordinates[0] || [] }],
          getPolygon: (d: { polygon: number[][] }) => d.polygon,
          filled: true,
          stroked: true,
          getFillColor: [14, 165, 233, 18],
          getLineColor: [56, 189, 248, 230],
          getLineWidth: 2,
          lineWidthMinPixels: 2,
          pickable: false,
        })
      );
    }

    // 1. Dynamic H3 dots/beacons with two-pass soft emissive glow across all zooms in dot mode
    if (!useHeatmapMode && clusteredBeacons.length > 0) {
      const beaconOpacity = extruded3D
        ? currentZoom < 5.6
          ? 1.0
          : 0.55
        : currentZoom < 6.0
          ? 1.0
          : 0.85;

      // Adaptive sizing: pinpoint at continental scale, clearly visible up close
      const isContinental = currentZoom < 4.2;
      const haloMin = isContinental ? 16 : 26;
      const haloMax = isContinental ? 40 : 68;
      const flameMin = isContinental ? 8 : 12;
      const flameMax = isContinental ? 18 : 28;
      const coreMin = isContinental ? 1.6 : 2.6;
      const coreMax = isContinental ? 3.2 : 5.0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const intensity = (d: any) => Math.sqrt(d.total_fires / maxClusterFires);

      // With culling off, glows on the far side of the globe would shine through
      // the planet, so drop the ones MapLibre reports as hidden behind it.
      const map = mapRef.current;
      const emberData =
        projection === "globe" && map
          ? clusteredBeacons.filter(
              (d) =>
                !map.transform.isLocationOccluded(
                  new maplibregl.LngLat(d.position[0], d.position[1])
                )
            )
          : clusteredBeacons;

      // Pass A: Wide, faint heat halo in the fire's intensity colour
      layers.push(
        new IconLayer({
          id: "fire-cluster-halo",
          data: emberData,
          pickable: false,
          iconAtlas: glowSprite,
          iconMapping: GLOW_ICON_MAPPING,
          getIcon: () => "glow",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getPosition: (d: any) => d.position,
          sizeUnits: "pixels",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getSize: (d: any) =>
            (haloMin + intensity(d) * (haloMax - haloMin)) *
            flickerFactor(flickerTime * 0.6, flickerPhase(d.id) + 1.3),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getColor: (d: any) => {
            const [r, g, b] = getFireColor(d.total_fires, maxClusterFires);
            return [r, g, b, Math.round(150 * beaconOpacity)];
          },
          parameters: ADDITIVE_GLOW_PARAMETERS,
          updateTriggers: {
            getColor: [maxClusterFires, sensorMode, beaconOpacity],
            getSize: [maxClusterFires, isContinental, flickerTime],
          },
        })
      );

      // Pass B: Brighter, tighter flame body that flickers
      layers.push(
        new IconLayer({
          id: "fire-cluster-flame",
          data: emberData,
          pickable: false,
          iconAtlas: glowSprite,
          iconMapping: GLOW_ICON_MAPPING,
          getIcon: () => "glow",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getPosition: (d: any) => d.position,
          sizeUnits: "pixels",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getSize: (d: any) =>
            (flameMin + intensity(d) * (flameMax - flameMin)) *
            flickerFactor(flickerTime, flickerPhase(d.id)),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getColor: (d: any) => {
            // Pull the intensity colour toward hot orange-yellow, like a flame body
            const [r, g, b] = getFireColor(d.total_fires, maxClusterFires);
            return [
              Math.round((r + 255) / 2),
              Math.round((g + 170) / 2),
              Math.round((b + 60) / 2),
              Math.round(
                235 *
                  beaconOpacity *
                  Math.min(1, flickerFactor(flickerTime, flickerPhase(d.id)))
              ),
            ];
          },
          parameters: ADDITIVE_GLOW_PARAMETERS,
          updateTriggers: {
            getColor: [maxClusterFires, sensorMode, beaconOpacity, flickerTime],
            getSize: [maxClusterFires, isContinental, flickerTime],
          },
        })
      );

      // Pass C: White-hot core; also the click / hover target (1-click zoom)
      layers.push(
        new ScatterplotLayer({
          id: "fire-cluster-core",
          data: clusteredBeacons,
          pickable: drawMode === "none",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getPosition: (d: any) => d.position,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getRadius: (d: any) =>
            coreMin +
            Math.sqrt(d.total_fires / maxClusterFires) * (coreMax - coreMin),
          radiusUnits: "pixels",
          radiusMinPixels: coreMin,
          radiusMaxPixels: coreMax,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getFillColor: [255, 244, 214, Math.round(240 * beaconOpacity)],
          stroked: false,
          updateTriggers: {
            getFillColor: [beaconOpacity],
            getRadius: [maxClusterFires, currentZoom],
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onClick: (info: any) => {
            if (info.object && mapRef.current && currentZoom < 10.5) {
              mapRef.current.flyTo({
                center: info.object.position,
                zoom: Math.max(currentZoom, Math.min(10.5, currentZoom + 2.2)),
                duration: 1100,
              });
            }
          },
          onHover: (info) => {
            if (
              info.object &&
              typeof info.x === "number" &&
              typeof info.y === "number"
            ) {
              setHoveredHex({
                datum: info.object as FireBeaconCluster,
                x: info.x,
                y: info.y,
              });
            } else {
              setHoveredHex(null);
            }
          },
        })
      );
    }

    // 2. High-resolution H3 Hexagon Layer (fades in starting at zoom 5.0, fully opaque at zoom >= 6.5)
    const hexOpacity =
      currentZoom >= 6.5
        ? 1.0
        : Math.max(0.0, (currentZoom - 5.0) / 1.5);

    if (!useHeatmapMode && hexOpacity > 0.05 && hexDataInView.length > 0) {
      // Flat footprint of each burning hexagon. In 3D View it sits under the
      // heat rings as a dim scorched patch; in 2D View it is the full-strength map.
      const h3Layer = new H3HexagonLayer<SpatialHexDatum>({
        id: "h3-fire-hexagons",
        data: hexDataInView,
        pickable: drawMode === "none" && currentZoom >= 6.0,
        wireframe: false,
        filled: true,
        extruded: false,
        // In 3D View the footprints breathe between faint and bright, in time
        // with the heat rings. This is one shared opacity, so it costs nothing
        // per hexagon. 2D View keeps them steady for reading values.
        opacity: extruded3D
          ? hexOpacity * (0.2 + 0.5 * (0.5 + 0.5 * Math.sin(flickerTime * 2.6)))
          : hexOpacity,
        getHexagon: (d) => d.h3_index,
        getFillColor: (d) => getFireColor(d.total_fires, maxFires),
        highPrecision: true,
        updateTriggers: {
          getFillColor: [maxFires, sensorMode],
        },
        onHover: (info) => {
          if (
            info.object &&
            typeof info.x === "number" &&
            typeof info.y === "number"
          ) {
            setHoveredHex({
              datum: info.object as SpatialHexDatum,
              x: info.x,
              y: info.y,
            });
          } else {
            setHoveredHex(null);
          }
        },
      });

      layers.push(h3Layer);
    }

    // 3. Pulsing heat rings spreading from each burning hexagon (3D View,
    //    zoomed in). Stronger fires send wider, faster rings in a hotter colour.
    const heatOpacity = Math.min(1, Math.max(0, currentZoom - 5.8));
    if (!useHeatmapMode && extruded3D && heatOpacity > 0.05 && heatPointsInView.length > 0) {
      const zoomScale = Math.min(1.7, Math.max(0.75, 0.75 + (currentZoom - 6.2) * 0.2));
      type HeatPoint = (typeof heatPointsInView)[number];
      type HeatRing = (typeof heatRings)[number];
      const strength = (d: { total_fires: number }) =>
        Math.min(1, Math.sqrt(d.total_fires / maxFiresInView));
      // 0 → ring just leaving the fire, 1 → fully spread and faded out.
      const ringProgress = (d: HeatRing) => {
        const period = 2.8 - 1.1 * strength(d); // seconds per pulse
        return (flickerTime / period + d.phase + d.ringOffset) % 1;
      };

      layers.push(
        new ScatterplotLayer<HeatRing>({
          id: "fire-heat-rings",
          data: heatRings,
          pickable: false,
          filled: false,
          stroked: true,
          radiusUnits: "pixels",
          lineWidthUnits: "pixels",
          getPosition: (d) => d.position,
          getRadius: (d) =>
            (4 + ringProgress(d) * (16 + strength(d) * 38)) * zoomScale,
          getLineWidth: (d) => 2.2 - 1.2 * ringProgress(d),
          getLineColor: (d) => {
            const [r, g, b] = getFireColor(d.total_fires, maxFiresInView);
            const fade = Math.pow(1 - ringProgress(d), 1.6);
            return [r, g, b, Math.round(235 * fade * heatOpacity)];
          },
          parameters: HEAT_RING_PARAMETERS,
          updateTriggers: {
            getRadius: [maxFiresInView, zoomScale, flickerTime],
            getLineWidth: [flickerTime],
            getLineColor: [maxFires, maxFiresInView, sensorMode, heatOpacity, flickerTime],
          },
        })
      );

      // White-hot point marking each fire's exact position
      layers.push(
        new ScatterplotLayer<HeatPoint>({
          id: "fire-heat-cores",
          data: heatPointsInView,
          pickable: false,
          stroked: false,
          radiusUnits: "pixels",
          radiusMinPixels: 2.5,
          getPosition: (d) => d.position,
          getRadius: (d) => (2.2 + strength(d) * 2.6) * zoomScale,
          getFillColor: [255, 244, 214, Math.round(240 * heatOpacity)],
          parameters: HEAT_RING_PARAMETERS,
          updateTriggers: {
            getRadius: [maxFiresInView, zoomScale],
            getFillColor: [heatOpacity],
          },
        })
      );
    }

    if (draftPolygonCoords) {
      layers.push(
        new PolygonLayer({
          id: "draft-aoi-preview",
          data: [{ polygon: draftPolygonCoords }],
          getPolygon: (d: { polygon: number[][] }) => d.polygon,
          filled: true,
          stroked: true,
          getFillColor: [245, 158, 11, 45],
          getLineColor: [251, 191, 36, 255],
          getLineWidth: 2.5,
          lineWidthMinPixels: 2,
          pickable: false,
        })
      );
    }

    if (draftVertices.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: "draft-aoi-vertices",
          data: draftVertices,
          getPosition: (d: [number, number]) => d,
          getFillColor: [251, 191, 36, 255],
          getLineColor: [15, 23, 42, 255],
          stroked: true,
          lineWidthMinPixels: 2,
          radiusMinPixels: 5,
          radiusMaxPixels: 7,
          pickable: false,
        })
      );
    }

    deckOverlayRef.current.setProps({ layers });
  }, [
    hexDataInView,
    useHeatmapMode,
    clusteredBeacons,
    maxClusterFires,
    currentZoom,
    aoi,
    hasCustomAoi,
    extruded3D,
    maxFires,
    sensorMode,
    draftPolygonCoords,
    draftVertices,
    drawMode,
    flickerTime,
    glowSprite,
    heatPointsInView,
    maxFiresInView,
    heatRings,
    projection,
    viewTick,
  ]);

  return (
    <div
      className={`relative w-full h-full rounded-xl overflow-hidden ${
        projection === "globe"
          ? // Globe floats directly on the page: no panel behind it.
            "bg-transparent"
          : "border border-slate-800 bg-slate-900 shadow-2xl"
      }`}
    >
      <div
        ref={mapContainerRef}
        className={`w-full h-full ${
          drawMode !== "none"
            ? "map-drawing-active cursor-crosshair"
            : "cursor-grab active:cursor-grabbing"
        }`}
      />

      {/* Top-Left Map Toolbar & Overlay Controls in Vertical Stack */}
      <div className="absolute top-3 left-3 z-10 flex flex-col items-start gap-2 max-w-[calc(100%-200px)]">
        {/* Tool Selection Bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-lg p-1 shadow-lg">
            <button
              type="button"
              onClick={handleCancelDraw}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                drawMode === "none"
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                  : "text-slate-300 hover:text-white hover:bg-slate-800"
              }`}
              title="Inspect & Pan Mode"
            >
              <MousePointer className="w-3.5 h-3.5" />
              <span>Inspect</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDraftVertices([]);
                setDrawMode("bbox");
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                drawMode === "bbox"
                  ? "bg-amber-500/25 text-amber-300 border border-amber-500/50"
                  : "text-slate-300 hover:text-white hover:bg-slate-800"
              }`}
              title="Draw a rectangular area to filter fire data"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Draw Box</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setDraftVertices([]);
                setDrawMode("polygon");
              }}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                drawMode === "polygon"
                  ? "bg-amber-500/25 text-amber-300 border border-amber-500/50"
                  : "text-slate-300 hover:text-white hover:bg-slate-800"
              }`}
              title="Draw a custom polygon to filter fire data"
            >
              <Pentagon className="w-3.5 h-3.5" />
              <span>Draw Polygon</span>
            </button>
          </div>

          {/* Reset Custom Area Button */}
          {hasCustomAoi && drawMode === "none" && (
            <button
              type="button"
              onClick={onResetAoi}
              className="flex items-center gap-1.5 bg-sky-950/90 hover:bg-sky-900 backdrop-blur-md border border-sky-500/50 text-sky-200 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition-colors"
              title="Clear custom drawn area and view all regions"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Area</span>
            </button>
          )}
        </div>

        {/* Interactive Drawing Instructions Pill: Positioned directly below the tool selection bar */}
        {drawMode !== "none" && (
          <div className="flex items-center gap-2 bg-amber-950/90 backdrop-blur-md border border-amber-500/60 text-amber-200 px-3 py-1.5 rounded-lg text-xs shadow-lg animate-in fade-in slide-in-from-top-1 duration-150">
            {drawMode === "bbox" ? (
              <span>
                {draftVertices.length === 0
                  ? "Click and drag on the map to draw a box"
                  : "Release mouse button to apply box selection"}
              </span>
            ) : (
              <span>Click map to add points ({draftVertices.length})</span>
            )}

            {drawMode === "polygon" && draftVertices.length >= 3 && (
              <button
                type="button"
                onClick={handleFinishPolygon}
                className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-0.5 rounded font-semibold transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
                Apply
              </button>
            )}

            <button
              type="button"
              onClick={handleCancelDraw}
              className="flex items-center gap-1 text-amber-300 hover:text-white px-1 py-0.5 rounded hover:bg-amber-900/50 transition-colors"
              title="Cancel Drawing (Esc)"
            >
              <X className="w-3.5 h-3.5" />
              <span className="text-[10px] opacity-75">Esc</span>
            </button>
          </div>
        )}
      </div>

      {/* Top-Right Map Controls: Basemap & 3D View Toggle */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={handleToggle3D}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border backdrop-blur-md shadow-lg transition-colors ${
            extruded3D
              ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
              : "bg-slate-900/90 border-slate-700/80 text-slate-300 hover:text-white"
          }`}
          title="Toggle the tilted 3D view with pulsing heat rings"
        >
          <Box className="w-3.5 h-3.5" />
          <span>{extruded3D ? "3D View" : "2D View"}</span>
        </button>

        <div className="flex items-center bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-lg p-1 shadow-lg">
          <button
            type="button"
            onClick={() => handleToggleProjection("globe")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              projection === "globe"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Show the map as a globe"
          >
            <Earth className="w-3.5 h-3.5" />
            <span>Globe</span>
          </button>
          <button
            type="button"
            onClick={() => handleToggleProjection("flat")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              projection === "flat"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
            title="Flatten the map to 2D"
          >
            <MapIcon className="w-3.5 h-3.5" />
            <span>Flat</span>
          </button>
        </div>

        <div className="flex items-center bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-lg p-1 shadow-lg">
          <button
            type="button"
            onClick={() => handleToggleBasemap("dark")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              basemap === "dark"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
            <span>Dark</span>
          </button>
          <button
            type="button"
            onClick={() => handleToggleBasemap("satellite")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              basemap === "satellite"
                ? "bg-slate-700 text-white"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Satellite</span>
          </button>
        </div>
      </div>

      {/* Bottom-Left Fire Activity Density Legend */}
      <div className="absolute bottom-3 left-3 z-10 bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-lg px-3 py-2.5 shadow-lg text-xs">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="font-semibold text-slate-200 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            Fire Density ({hexData.length.toLocaleString()} Active Zones)
            {useHeatmapMode && (
              <span className="text-[10px] font-medium text-amber-300 bg-amber-500/15 border border-amber-500/40 px-1.5 py-0.5 rounded">
                Heatmap
              </span>
            )}
          </span>
          {activeSliceLabel && (
            <span className="text-[11px] font-mono text-sky-300 bg-sky-500/10 border border-sky-500/30 px-1.5 py-0.5 rounded">
              {activeSliceLabel}
            </span>
          )}
        </div>
        {dailyStudyAreaOnly && (
          <div className="mb-1.5 max-w-[230px] text-[10px] leading-snug text-amber-300/90">
            Daily view shows Southeast Asia only — elsewhere fires are recorded
            weekly.
          </div>
        )}
        {loading && (
          <div className="mb-1.5 text-[11px] text-amber-400 animate-pulse">
            Updating...
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-400">Low</span>
          <div className="h-2 w-8 rounded-sm bg-yellow-300/90" />
          <div className="h-2 w-8 rounded-sm bg-orange-400/90" />
          <div className="h-2 w-8 rounded-sm bg-red-500/90" />
          <div className="h-2 w-8 rounded-sm bg-rose-600" />
          <span className="text-[10px] text-slate-400">
            High ({maxFires.toLocaleString()} fires)
          </span>
        </div>
      </div>

      {/* Hover Tooltip for Fire Zone or Cluster */}
      {hoveredHex && (
        <div
          className="pointer-events-none absolute z-20 bg-slate-950/95 border border-slate-700 rounded-lg px-3 py-2 text-xs shadow-2xl"
          style={{
            left: Math.min(hoveredHex.x + 14, 380),
            top: Math.max(hoveredHex.y - 74, 12),
          }}
        >
          {"zone_count" in hoveredHex.datum &&
          hoveredHex.datum.zone_count > 1 ? (
            <div className="font-semibold text-[11px] text-amber-400 mb-1 flex items-center justify-between gap-3">
              <span>Regional Fire Cluster</span>
              <span className="text-[10px] text-slate-400 font-mono">
                ({hoveredHex.datum.zone_count} Zones)
              </span>
            </div>
          ) : (
            <div className="font-semibold text-[11px] text-sky-400 mb-1">
              Active Fire Zone
            </div>
          )}
          <div className="flex items-center justify-between gap-4 text-slate-200">
            <span>Total Hotspots:</span>
            <strong className="text-amber-400 font-semibold">
              {hoveredHex.datum.total_fires.toLocaleString()}
            </strong>
          </div>
          <div className="flex items-center justify-between gap-4 text-slate-300">
            <span>Mean Intensity:</span>
            <strong className="text-rose-400 font-semibold">
              {hoveredHex.datum.mean_frp.toFixed(1)} MW
            </strong>
          </div>
          {"zone_count" in hoveredHex.datum &&
            hoveredHex.datum.zone_count > 1 && (
              <div className="mt-1.5 pt-1 border-t border-slate-800 text-[10px] text-sky-400/90 font-medium">
                Click beacon to zoom in
              </div>
            )}
        </div>
      )}
    </div>
  );
};
