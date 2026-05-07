"use client";

import maplibregl, {
  type FeatureIdentifier,
  type GeoJSONSource,
  type LayerSpecification,
  type Map as MaplibreMap,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection, Point } from "geojson";
import { Activity, Globe2, Loader2, MapPin, Radar, Waves, X } from "lucide-react";

import { cn } from "@/lib/utils";

// ─── Config ────────────────────────────────────────────────────────────────────
const GEO_SRC = "osint-threatmap-geo";
const HEAT_SRC = "osint-threatmap-heat";
const GLOW_LAYER = "threatmap-glow";
const PULSE_LAYER = "threatmap-pulse";
const POINT_LAYER = "threatmap-points";
const LABEL_LAYER = "threatmap-labels";
const HEAT_LAYER = "threatmap-heat";

// ─── Gazetteer (name → [lat, lng]) ────────────────────────────────────────────
const GAZETTEER: Record<string, [number, number]> = {
  "afghanistan": [33.9391, 67.7100],
  "africa": [1.6508, 19.5987],
  "algeria": [28.0339, 1.6596],
  "amsterdam": [52.3676, 4.9041],
  "asia": [29.8406, 89.2969],
  "australia": [-25.2744, 133.7751],
  "bangalore": [12.9716, 77.5946],
  "bengaluru": [12.9716, 77.5946],
  "berlin": [52.52, 13.405],
  "brazil": [-14.235, -51.9253],
  "cairo": [30.0444, 31.2357],
  "canada": [56.1304, -106.3468],
  "chennai": [13.0827, 80.2707],
  "china": [35.8617, 104.1954],
  "delhi": [28.6139, 77.2090],
  "dubai": [25.2048, 55.2708],
  "europe": [54.526, 15.2551],
  "france": [46.2276, 2.2137],
  "germany": [51.1657, 10.4515],
  "hyderabad": [17.385, 78.4867],
  "india": [20.5937, 78.9629],
  "indonesia": [-0.7893, 113.9213],
  "iran": [32.4279, 53.6880],
  "iraq": [33.2232, 43.6793],
  "israel": [31.0461, 34.8516],
  "istanbul": [41.0082, 28.9784],
  "italy": [41.8719, 12.5674],
  "jakarta": [-6.2088, 106.8456],
  "japan": [36.2048, 138.2529],
  "karachi": [24.8607, 67.0011],
  "kolkata": [22.5726, 88.3639],
  "london": [51.5072, -0.1276],
  "los angeles": [34.0522, -118.2437],
  "malaysia": [4.2105, 101.9758],
  "mexico": [23.6345, -102.5528],
  "moscow": [55.7558, 37.6176],
  "mumbai": [19.076, 72.8777],
  "myanmar": [21.9162, 95.9560],
  "nairobi": [-1.2921, 36.8219],
  "netherlands": [52.1326, 5.2913],
  "new delhi": [28.6139, 77.2090],
  "new york": [40.7128, -74.006],
  "nigeria": [9.082, 8.6753],
  "north korea": [40.3399, 127.5101],
  "pakistan": [30.3753, 69.3451],
  "paris": [48.8566, 2.3522],
  "philippines": [12.8797, 121.7740],
  "pune": [18.5204, 73.8567],
  "russia": [61.524, 105.3188],
  "san francisco": [37.7749, -122.4194],
  "sao paulo": [-23.5558, -46.6396],
  "saudi arabia": [23.8859, 45.0792],
  "seoul": [37.5665, 126.978],
  "shanghai": [31.2304, 121.4737],
  "singapore": [1.3521, 103.8198],
  "south africa": [-30.5595, 22.9375],
  "south korea": [35.9078, 127.7669],
  "spain": [40.4637, -3.7492],
  "sydney": [-33.8688, 151.2093],
  "taiwan": [23.6978, 120.9605],
  "thailand": [15.87, 100.9925],
  "tokyo": [35.6762, 139.6503],
  "toronto": [43.6532, -79.3832],
  "turkey": [38.9637, 35.2433],
  "ukraine": [48.3794, 31.1656],
  "united kingdom": [55.3781, -3.4360],
  "united states": [37.0902, -95.7129],
  "usa": [37.0902, -95.7129],
  "uk": [55.3781, -3.4360],
  "uae": [23.4241, 53.8478],
  "vietnam": [14.0583, 108.2772],
  "washington": [38.9072, -77.0369],
  "washington dc": [38.9072, -77.0369],
};

function lookupGeo(value: string): [number, number] | null {
  const key = value.toLowerCase().trim();
  const exact = GAZETTEER[key];
  if (exact) return exact;
  // Partial match
  for (const [k, v] of Object.entries(GAZETTEER)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface GeoPin {
  id: string;
  value: string;
  lng: number;
  lat: number;
  count: number;
  confidence: number;
  addedAt: number;
}

interface PointProps {
  id: string;
  name: string;
  count: number;
  confidence: number;
}

interface TooltipState {
  x: number;
  y: number;
  name: string;
  count: number;
  confidence: number;
}

interface IncomingEntity {
  kind: string;
  value: string;
  count: number;
  confidence?: number;
}

const EMPTY_FC: FeatureCollection<Point, PointProps> = { type: "FeatureCollection", features: [] };

// ─── Map style ─────────────────────────────────────────────────────────────────
function buildStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      "carto-dark": {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "© CartoDB © OpenStreetMap contributors",
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: "carto-dark-tiles",
        type: "raster",
        source: "carto-dark",
        paint: {
          "raster-opacity": 0.96,
          "raster-brightness-min": 0.0,
          "raster-brightness-max": 0.95,
          "raster-saturation": -0.25,
          "raster-contrast": 0.08,
        },
      },
    ],
  };
}

// ─── Main component ────────────────────────────────────────────────────────────
export function ThreatIntelMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [pins, setPins] = useState<GeoPin[]>([]);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pinsRef = useRef<GeoPin[]>([]);

  // Keep pinsRef in sync so the GeoJSON update effect can read fresh data
  useEffect(() => { pinsRef.current = pins; }, [pins]);

  // ─── Pulse animation for high-confidence pins ─────────────────────────────
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    let frame = 0;
    const id = setInterval(() => {
      if (!map.getLayer(PULSE_LAYER)) return;
      frame = (frame + 1) % 80;
      const t = frame / 80;
      const pulse = Math.sin(t * Math.PI * 2) * 0.5 + 0.5; // 0→1→0
      map.setPaintProperty(PULSE_LAYER, "circle-opacity", pulse * 0.22);
      map.setPaintProperty(PULSE_LAYER, "circle-stroke-opacity", 0.3 + pulse * 0.55);
    }, 50);
    return () => clearInterval(id);
  }, [mapReady]);

  // ─── Init map ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: buildStyle(),
      center: [15, 25],
      zoom: 1.7,
      attributionControl: false,
      fadeDuration: 200,
    });

    mapRef.current = map;

    map.on("load", () => {
      // GeoJSON source for entity points
      map.addSource(GEO_SRC, { type: "geojson", data: EMPTY_FC });

      // Pulse ring for high-confidence pins
      map.addLayer({
        id: PULSE_LAYER,
        type: "circle",
        source: GEO_SRC,
        filter: [">=", ["get", "confidence"], 0.7],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 18, 10, 34, 25, 56],
          "circle-color": "#22d3ee",
          "circle-opacity": 0.0,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#22d3ee",
          "circle-stroke-opacity": 0.55,
          "circle-blur": 0.6,
        },
      } as LayerSpecification);

      // Glow / halo layer
      map.addLayer({
        id: GLOW_LAYER,
        type: "circle",
        source: GEO_SRC,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 12, 5, 22, 10, 40],
          "circle-color": "#22d3ee",
          "circle-opacity": 0.14,
          "circle-blur": 1.0,
        },
      } as LayerSpecification);

      // Main point layer
      map.addLayer({
        id: POINT_LAYER,
        type: "circle",
        source: GEO_SRC,
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "count"],
            1, 5,
            5, 8,
            10, 12,
            25, 16,
          ],
          "circle-color": [
            "interpolate",
            ["linear"],
            ["get", "confidence"],
            0, "#60a5fa",
            0.5, "#22d3ee",
            0.8, "#34d399",
            1, "#f9fafb",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 0.8,
          "circle-opacity": 0.88,
        },
      } as LayerSpecification);

      // Label layer
      map.addLayer({
        id: LABEL_LAYER,
        type: "symbol",
        source: GEO_SRC,
        minzoom: 3,
        layout: {
          "text-field": ["get", "name"],
          "text-size": 10,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-font": ["Open Sans Regular"],
        },
        paint: {
          "text-color": "#e2e8f0",
          "text-halo-color": "#000000",
          "text-halo-width": 1.2,
          "text-opacity": 0.85,
        },
      } as LayerSpecification);

      // Tooltip interaction
      map.on("mouseenter", POINT_LAYER, (e: MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0] as Feature<Point, PointProps> | undefined;
        if (!f) return;
        setTooltip({
          x: e.point.x,
          y: e.point.y,
          name: f.properties.name,
          count: f.properties.count,
          confidence: f.properties.confidence,
        });
      });
      map.on("mousemove", POINT_LAYER, (e: MapLayerMouseEvent) => {
        const f = e.features?.[0] as Feature<Point, PointProps> | undefined;
        if (!f) return;
        setTooltip({
          x: e.point.x,
          y: e.point.y,
          name: f.properties.name,
          count: f.properties.count,
          confidence: f.properties.confidence,
        });
      });
      map.on("mouseleave", POINT_LAYER, () => {
        map.getCanvas().style.cursor = "";
        setTooltip(null);
      });

      setMapReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // ─── Update GeoJSON source when pins change ─────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource(GEO_SRC) as GeoJSONSource | undefined;
    if (!src) return;

    const fc: FeatureCollection<Point, PointProps> = {
      type: "FeatureCollection",
      features: pins.map((pin) => ({
        type: "Feature",
        id: pin.id,
        geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
        properties: {
          id: pin.id,
          name: pin.value,
          count: pin.count,
          confidence: pin.confidence,
        },
      })),
    };
    src.setData(fc);
  }, [pins, mapReady]);

  // ─── Listen to entity extraction events ────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    function handler(ev: Event) {
      const detail = (ev as CustomEvent<{ entities: IncomingEntity[] }>).detail;
      const geoEntities = detail.entities.filter((e) => e.kind === "GEO");

      setPins((prev) => {
        const next = [...prev];
        for (const entity of geoEntities) {
          const coords = lookupGeo(entity.value);
          if (!coords) continue;
          const existing = next.find((p) => p.value.toLowerCase() === entity.value.toLowerCase());
          if (existing) {
            existing.count += entity.count;
            if (typeof entity.confidence === "number") {
              existing.confidence = Math.max(existing.confidence, entity.confidence);
            }
          } else {
            next.push({
              id: `geo-${entity.value.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
              value: entity.value,
              lat: coords[0],
              lng: coords[1],
              count: entity.count,
              confidence: typeof entity.confidence === "number" ? entity.confidence : 0.5,
              addedAt: Date.now(),
            });
          }
        }
        // Keep latest 100 pins
        return next.slice(-100);
      });
    }

    window.addEventListener("osint:entities-extracted", handler);
    return () => window.removeEventListener("osint:entities-extracted", handler);
  }, []);

  // ─── Tooltip positioning ───────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (tooltipRef.current && tooltip) {
      tooltipRef.current.style.transform = `translate(${tooltip.x + 14}px, ${tooltip.y + 14}px)`;
    }
  }, [tooltip]);

  const uniqueCountries = pins.length;
  const totalMentions = pins.reduce((s, p) => s + p.count, 0);
  const topPin = [...pins].sort((a, b) => b.count - a.count)[0];

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#06060a]">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Radar size={14} className="text-cyan-400 animate-spin [animation-duration:8s]" aria-hidden />
          <span className="text-[11px] font-bold uppercase tracking-widest text-foreground/70">
            Threat-Intel Geo-Map
          </span>
          {mapReady && (
            <span className="rounded-full bg-green-500/15 px-2 py-px text-[9px] font-semibold text-green-400">
              LIVE
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted/60">
          <span className="flex items-center gap-1">
            <MapPin size={9} className="text-cyan-400" aria-hidden />
            {uniqueCountries} locations
          </span>
          <span className="flex items-center gap-1">
            <Activity size={9} className="text-amber-400" aria-hidden />
            {totalMentions} signals
          </span>
          {topPin && (
            <span className="flex items-center gap-1">
              <Waves size={9} className="text-rose-400" aria-hidden />
              top: {topPin.value}
            </span>
          )}
        </div>
      </div>

      {/* Map container */}
      <div className="relative h-[560px] w-full">
        {!mapReady && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#06060a]">
            <Loader2 size={22} className="animate-spin text-cyan-500" aria-hidden />
            <span className="text-[11px] text-muted/60">Loading geo-intelligence layer…</span>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />

        {/* Confidence legend */}
        <div className="absolute bottom-8 left-3 z-10 rounded-md border border-white/10 bg-[#06060a]/80 px-2.5 py-1.5 backdrop-blur pointer-events-none">
          <div className="mb-1 text-[8px] font-semibold uppercase tracking-widest text-muted/50">Confidence</div>
          <div className="flex flex-col gap-0.5">
            {[
              { color: "#f9fafb", label: "1.0 — critical" },
              { color: "#34d399", label: "≥ 0.8 — high" },
              { color: "#22d3ee", label: "≥ 0.5 — med" },
              { color: "#60a5fa", label: "< 0.5 — low" },
            ].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
                <span className="text-[8px] text-muted/60">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Attribution */}
        <div className="absolute bottom-1.5 right-2 pointer-events-none text-[8px] text-white/20">
          © CartoDB © OpenStreetMap
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div
            ref={tooltipRef}
            className="pointer-events-none absolute left-0 top-0 z-20 min-w-[160px] rounded-lg border border-white/12 bg-[#09090f]/92 px-3 py-2 shadow-xl backdrop-blur"
          >
            <div className="flex items-center gap-1.5">
              <MapPin size={10} className="text-cyan-400 shrink-0" aria-hidden />
              <span className="text-[11px] font-semibold text-foreground/90">{tooltip.name}</span>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-muted/70">
              <span>Signals</span>
              <span className="text-right text-cyan-300">{tooltip.count}</span>
              <span>Confidence</span>
              <span className="text-right text-amber-300">{(tooltip.confidence * 100).toFixed(0)}%</span>
            </div>
          </div>
        )}

        {/* Empty-state overlay */}
        {mapReady && pins.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <Globe2 size={24} className="text-muted/20" aria-hidden />
            <p className="text-[11px] text-muted/40">Run a feed query to populate geo-intelligence markers.</p>
          </div>
        )}
      </div>

      {/* Pin list */}
      {pins.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-white/8 px-4 py-2.5">
          {[...pins]
            .sort((a, b) => b.count - a.count)
            .slice(0, 18)
            .map((pin) => (
              <button
                key={pin.id}
                type="button"
                className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] transition hover:border-cyan-500/40 hover:bg-cyan-950/20"
                onClick={() => {
                  const map = mapRef.current;
                  if (!map) return;
                  map.flyTo({ center: [pin.lng, pin.lat], zoom: 5, duration: 1200 });
                }}
              >
                <span
                  className="size-1.5 rounded-full bg-cyan-400"
                  style={{ opacity: 0.4 + pin.confidence * 0.6 }}
                  aria-hidden
                />
                <span className="text-muted/80">{pin.value}</span>
                <span className="text-cyan-300">{pin.count}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
