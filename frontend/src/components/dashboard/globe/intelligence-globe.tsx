"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type LayerSpecification, type Map as MaplibreMap, type MapLayerMouseEvent, type StyleSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { AlertTriangle, Crosshair, Database, Loader2, RadioTower, ShieldCheck } from "lucide-react";

import { resolveGeoCoordinate, offsetEntityAnchor } from "@/lib/geo-coordinates";
import { cn, formatNumber } from "@/lib/utils";
import type { GeoConnectedGraphEntity, GeoGraph, GeoLocationEntity, GeoRelationshipEdge } from "@/types/intelligence";
import { StatusPill } from "@/components/ui/status-pill";

const GEO_POINTS_SOURCE = "osint-geo-points";
const GEO_ARCS_SOURCE = "osint-geo-arcs";
const GEO_GRATICULE_SOURCE = "osint-geo-graticule";
const GEO_POINTS_HIT_LAYER = "osint-geo-points-hit";
const GEO_ARCS_HIT_LAYER = "osint-geo-arcs-hit";
const EMPTY_POINTS: FeatureCollection<Point, GlobePointProperties> = { type: "FeatureCollection", features: [] };
const EMPTY_ARCS: FeatureCollection<LineString, GlobeArcProperties> = { type: "FeatureCollection", features: [] };
const GRATICULE_DATA = createGraticuleData();

type GlobeStatus = "loading" | "ready" | "error";

interface GlobePointProperties {
  id: string;
  name: string;
  confidence: number | null;
  source: "stored" | "gazetteer";
  sourceCount: number | null;
}

interface GlobeArcProperties {
  id: string;
  locationId: string;
  locationName: string;
  entityId: string;
  entityName: string;
  entityType: "ORG" | "PERSON";
  confidence: number | null;
  evidenceText: string | null;
}

interface GlobeLayerData {
  points: FeatureCollection<Point, GlobePointProperties>;
  arcs: FeatureCollection<LineString, GlobeArcProperties>;
  totalLocations: number;
  unresolvedLocations: number;
  connectedEntities: number;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  detail: string;
  tone: "cyan" | "blue" | "green" | "amber";
}

interface GeoGraphApiPayload {
  generated_at?: unknown;
  limit?: unknown;
  locations?: unknown;
  connected_entities?: unknown;
  relationships?: unknown;
}

interface GeoLocationApiPayload {
  id?: unknown;
  canonical_name?: unknown;
  confidence?: unknown;
  source_count?: unknown;
  last_updated?: unknown;
  latitude?: unknown;
  longitude?: unknown;
}

interface GeoConnectedEntityApiPayload {
  id?: unknown;
  entity_type?: unknown;
  canonical_name?: unknown;
  confidence?: unknown;
  last_updated?: unknown;
}

interface GeoRelationshipApiPayload {
  id?: unknown;
  source_entity_id?: unknown;
  destination_entity_id?: unknown;
  confidence?: unknown;
  valid_from?: unknown;
  evidence_text?: unknown;
}

export function IntelligenceGlobe() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [status, setStatus] = useState<GlobeStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [geoGraph, setGeoGraph] = useState<GeoGraph | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const layerData = useMemo(() => buildGlobeLayerData(geoGraph), [geoGraph]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || mapRef.current !== null) {
      return;
    }

    const map = new maplibregl.Map({
      container,
      style: createGlobeStyle(),
      center: [72.8777, 19.076],
      zoom: 1.2,
      minZoom: 0.6,
      maxZoom: 8,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      maplibreLogo: false,
      renderWorldCopies: false,
      canvasContextAttributes: {
        antialias: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
        contextType: "webgl2",
      },
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true, visualizePitch: true }), "bottom-right");

    map.once("load", () => {
      installGlobeLayers(map);
      bindMapInteractions(map, setTooltip);
      setMapReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function fetchGeoGraph() {
      setStatus("loading");
      setError(null);
      try {
        const response = await fetch("/api/intelligence/geo?limit=5000", { cache: "no-store" });
        const payload = (await response.json()) as unknown;
        if (hasErrorPayload(payload)) {
          throw new Error(readError(payload));
        }
        if (!response.ok) {
          throw new Error(readError(payload));
        }
        if (!cancelled) {
          setGeoGraph(parseGeoGraph(payload));
          setStatus("ready");
        }
      } catch (fetchError) {
        if (!cancelled) {
          setStatus("error");
          setError(fetchError instanceof Error ? fetchError.message : "Unable to load GEO graph.");
        }
      }
    }
    void fetchGeoGraph();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !mapReady) {
      return;
    }
    setGeoJsonSourceData(map, GEO_POINTS_SOURCE, layerData.points);
    setGeoJsonSourceData(map, GEO_ARCS_SOURCE, layerData.arcs);
  }, [layerData, mapReady]);

  useLayoutEffect(() => {
    if (tooltipRef.current !== null && tooltip !== null) {
      tooltipRef.current.style.transform = `translate(${tooltip.x + 12}px, ${tooltip.y + 12}px)`;
    }
  }, [tooltip]);

  return (
    <div className="relative min-h-[520px] overflow-hidden bg-background">
      <div ref={containerRef} className="osint-globe-map absolute inset-0" />
      <div className="pointer-events-none absolute left-3 top-3 grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={status === "ready" ? "green" : status === "error" ? "rose" : "amber"}>{status === "ready" ? "Synced" : status}</StatusPill>
          <StatusPill tone="cyan">{formatNumber(layerData.points.features.length)} plotted</StatusPill>
          <StatusPill tone="blue">{formatNumber(layerData.arcs.features.length)} arcs</StatusPill>
        </div>
        <div className="grid gap-1 rounded-md border border-border bg-panel/90 px-2.5 py-2 text-xs text-muted shadow-lg shadow-black/30 backdrop-blur">
          <span className="flex items-center gap-2">
            <Crosshair size={13} className="text-accent-cyan" aria-hidden="true" />
            {formatNumber(layerData.totalLocations)} GEO nodes fetched
          </span>
          <span className="flex items-center gap-2">
            <Database size={13} className="text-accent-blue" aria-hidden="true" />
            {formatNumber(layerData.connectedEntities)} connected ORG/PERSON entities
          </span>
          <span>{formatNumber(layerData.unresolvedLocations)} unresolved coordinates</span>
        </div>
      </div>
      {status === "loading" ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/35 text-sm text-muted backdrop-blur-[1px]">
          <span className="flex items-center gap-2 rounded-md border border-border bg-panel/90 px-3 py-2">
            <Loader2 size={16} className="animate-spin text-accent-cyan" aria-hidden="true" />
            Fetching GEO graph
          </span>
        </div>
      ) : null}
      {status === "error" ? (
        <OfflineGlobeState error={error ?? "Unable to load GEO graph."} />
      ) : null}
      {tooltip === null ? null : (
        <div
          ref={tooltipRef}
          className={cn("pointer-events-none absolute z-10 max-w-xs rounded-md border bg-panel/95 px-3 py-2 text-xs shadow-xl shadow-black/40", tooltipToneClass(tooltip.tone))}
          data-globe-tooltip
        >
          <div className="font-semibold text-foreground">{tooltip.title}</div>
          <div className="mt-1 text-muted">{tooltip.detail}</div>
        </div>
      )}
    </div>
  );
}

function OfflineGlobeState({ error }: { error: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 top-24 grid place-items-center text-sm text-muted">
      <div className="w-full max-w-2xl rounded-md border border-accent-rose/25 bg-panel/95 p-4 shadow-2xl shadow-black/40 backdrop-blur">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-md border border-accent-rose/25 bg-accent-rose/10 text-accent-rose">
            <AlertTriangle size={19} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-base font-semibold text-foreground">GEO graph feed offline</div>
            <div className="mt-1 leading-5">The globe is waiting for the local Intelligence API to expose resolved GEO entities and relationship arcs.</div>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <GlobeStateCell icon={RadioTower} label="Ingress" value="Redpanda" />
          <GlobeStateCell icon={Database} label="Graph" value="ArcadeDB" />
          <GlobeStateCell icon={ShieldCheck} label="API" value="FastAPI" />
        </div>
        <div className="mt-3 rounded-md border border-border bg-black/18 px-3 py-2 font-mono text-xs text-muted">{error}</div>
      </div>
    </div>
  );
}

function GlobeStateCell({ icon: Icon, label, value }: { icon: typeof RadioTower; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-panel-strong/75 px-3 py-2">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-muted">
        <Icon size={13} className="text-accent-cyan" aria-hidden="true" />
        {label}
      </div>
      <div className="mt-1 font-mono text-xs text-foreground">{value}</div>
    </div>
  );
}

function createGlobeStyle(): StyleSpecification {
  return {
    version: 8,
    projection: { type: "globe" },
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#050505" },
      },
    ],
  };
}

function installGlobeLayers(map: MaplibreMap) {
  map.addSource(GEO_GRATICULE_SOURCE, { type: "geojson", data: GRATICULE_DATA });
  map.addSource(GEO_ARCS_SOURCE, { type: "geojson", data: EMPTY_ARCS, lineMetrics: true });
  map.addSource(GEO_POINTS_SOURCE, { type: "geojson", data: EMPTY_POINTS });

  map.addLayer({
    id: "osint-geo-graticule-lines",
    type: "line",
    source: GEO_GRATICULE_SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "kind"], "meridian", "#f5f5f5", "parallel", "#bdbdbd", "#f5f5f5"],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.11, 4, 0.2, 8, 0.28],
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.35, 5, 0.8],
    },
  } as LayerSpecification);

  map.addLayer({
    id: "osint-geo-arcs-glow",
    type: "line",
    source: GEO_ARCS_SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "entityType"], "PERSON", "#f5f5f5", "ORG", "#d4d4d4", "#a3a3a3"],
      "line-opacity": 0.28,
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 1.5, 4, 4.5, 8, 8],
      "line-blur": 5,
    },
  } as LayerSpecification);

  map.addLayer({
    id: GEO_ARCS_HIT_LAYER,
    type: "line",
    source: GEO_ARCS_SOURCE,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["match", ["get", "entityType"], "PERSON", "#f5f5f5", "ORG", "#d4d4d4", "#a3a3a3"],
      "line-opacity": 0.72,
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.75, 4, 2.5, 8, 5],
    },
  } as LayerSpecification);

  map.addLayer({
    id: "osint-geo-points-glow",
    type: "circle",
    source: GEO_POINTS_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 7, 4, 18, 8, 32],
      "circle-color": ["match", ["get", "source"], "stored", "#f5f5f5", "gazetteer", "#cfcfcf", "#cfcfcf"],
      "circle-opacity": 0.24,
      "circle-blur": 0.75,
    },
  } as LayerSpecification);

  map.addLayer({
    id: GEO_POINTS_HIT_LAYER,
    type: "circle",
    source: GEO_POINTS_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 3.5, 4, 8, 8, 14],
      "circle-color": ["match", ["get", "source"], "stored", "#f5f5f5", "gazetteer", "#cfcfcf", "#cfcfcf"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 5, 1.2],
      "circle-opacity": 0.92,
      "circle-stroke-opacity": 0.42,
    },
  } as LayerSpecification);
}

function bindMapInteractions(map: MaplibreMap, setTooltip: (tooltip: TooltipState | null) => void) {
  const showPointTooltip = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0] as Feature<Point, GlobePointProperties> | undefined;
    if (feature === undefined) {
      return;
    }
    map.getCanvas().style.cursor = "pointer";
    setTooltip({
      x: event.point.x,
      y: event.point.y,
      title: feature.properties.name,
      detail: `${feature.properties.source} coordinates, confidence ${formatConfidence(feature.properties.confidence)}`,
      tone: feature.properties.source === "stored" ? "green" : "cyan",
    });
  };

  const showArcTooltip = (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0] as Feature<LineString, GlobeArcProperties> | undefined;
    if (feature === undefined) {
      return;
    }
    map.getCanvas().style.cursor = "pointer";
    setTooltip({
      x: event.point.x,
      y: event.point.y,
      title: `${feature.properties.locationName} to ${feature.properties.entityName}`,
      detail: feature.properties.evidenceText ?? `${feature.properties.entityType} relationship, confidence ${formatConfidence(feature.properties.confidence)}`,
      tone: feature.properties.entityType === "ORG" ? "blue" : "cyan",
    });
  };

  const hideTooltip = () => {
    map.getCanvas().style.cursor = "";
    setTooltip(null);
  };

  map.on("mousemove", GEO_POINTS_HIT_LAYER, showPointTooltip);
  map.on("mouseleave", GEO_POINTS_HIT_LAYER, hideTooltip);
  map.on("mousemove", GEO_ARCS_HIT_LAYER, showArcTooltip);
  map.on("mouseleave", GEO_ARCS_HIT_LAYER, hideTooltip);
}

function setGeoJsonSourceData(map: MaplibreMap, sourceId: string, data: FeatureCollection<Point | LineString, GlobePointProperties | GlobeArcProperties>) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

function createGraticuleData(): FeatureCollection<LineString, { kind: "meridian" | "parallel" }> {
  const features: Array<Feature<LineString, { kind: "meridian" | "parallel" }>> = [];
  for (let longitude = -180; longitude <= 180; longitude += 15) {
    const coordinates: Array<[number, number]> = [];
    for (let latitude = -80; latitude <= 80; latitude += 4) {
      coordinates.push([longitude, latitude]);
    }
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { kind: "meridian" } });
  }
  for (let latitude = -75; latitude <= 75; latitude += 15) {
    const coordinates: Array<[number, number]> = [];
    for (let longitude = -180; longitude <= 180; longitude += 4) {
      coordinates.push([longitude, latitude]);
    }
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { kind: "parallel" } });
  }
  return { type: "FeatureCollection", features };
}

function buildGlobeLayerData(graph: GeoGraph | null): GlobeLayerData {
  if (graph === null) {
    return { points: EMPTY_POINTS, arcs: EMPTY_ARCS, totalLocations: 0, unresolvedLocations: 0, connectedEntities: 0 };
  }

  const pointByLocationId = new Map<string, Feature<Point, GlobePointProperties>>();
  let unresolvedLocations = 0;
  for (const location of graph.locations) {
    const coordinate = resolveGeoCoordinate(location);
    if (coordinate === null) {
      unresolvedLocations += 1;
      continue;
    }
    pointByLocationId.set(location.id, {
      type: "Feature",
      geometry: { type: "Point", coordinates: [coordinate.longitude, coordinate.latitude] },
      properties: {
        id: location.id,
        name: location.canonicalName,
        confidence: location.confidence,
        source: coordinate.source,
        sourceCount: location.sourceCount,
      },
    });
  }

  const connectedById = new Map(graph.connectedEntities.map((entity) => [entity.id, entity]));
  const arcs: Array<Feature<LineString, GlobeArcProperties>> = [];
  for (const relationship of graph.relationships) {
    const arc = toArcFeature(relationship, pointByLocationId, connectedById);
    if (arc !== null) {
      arcs.push(arc);
    }
  }

  return {
    points: { type: "FeatureCollection", features: Array.from(pointByLocationId.values()) },
    arcs: { type: "FeatureCollection", features: arcs },
    totalLocations: graph.locations.length,
    unresolvedLocations,
    connectedEntities: graph.connectedEntities.length,
  };
}

function toArcFeature(
  relationship: GeoRelationshipEdge,
  pointByLocationId: Map<string, Feature<Point, GlobePointProperties>>,
  connectedById: Map<string, GeoConnectedGraphEntity>,
): Feature<LineString, GlobeArcProperties> | null {
  const sourcePoint = relationship.sourceEntityId === null ? undefined : pointByLocationId.get(relationship.sourceEntityId);
  const destinationPoint = relationship.destinationEntityId === null ? undefined : pointByLocationId.get(relationship.destinationEntityId);
  const locationPoint = sourcePoint ?? destinationPoint;
  const locationId = sourcePoint !== undefined ? relationship.sourceEntityId : relationship.destinationEntityId;
  const entityId = sourcePoint !== undefined ? relationship.destinationEntityId : relationship.sourceEntityId;
  if (locationPoint === undefined || locationId === null || entityId === null) {
    return null;
  }
  const connectedEntity = connectedById.get(entityId);
  if (connectedEntity === undefined) {
    return null;
  }
  const [sourceLongitude, sourceLatitude] = locationPoint.geometry.coordinates;
  if (typeof sourceLongitude !== "number" || typeof sourceLatitude !== "number") {
    return null;
  }
  const targetPosition = offsetEntityAnchor(sourceLatitude, sourceLongitude, connectedEntity.id);
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: greatCircleCoordinates([sourceLongitude, sourceLatitude], [targetPosition[0], targetPosition[1]], 24),
    },
    properties: {
      id: relationship.id,
      locationId,
      locationName: locationPoint.properties.name,
      entityId: connectedEntity.id,
      entityName: connectedEntity.canonicalName,
      entityType: connectedEntity.entityType,
      confidence: relationship.confidence,
      evidenceText: relationship.evidenceText,
    },
  };
}

function greatCircleCoordinates(source: [number, number], target: [number, number], segments: number): Array<[number, number]> {
  const coordinates: Array<[number, number]> = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    coordinates.push([source[0] + (target[0] - source[0]) * t, source[1] + (target[1] - source[1]) * t]);
  }
  return coordinates;
}

function parseGeoGraph(payload: unknown): GeoGraph {
  if (!isRecord(payload)) {
    return emptyGeoGraph();
  }
  const graph = payload as GeoGraphApiPayload;
  return {
    generatedAt: asString(graph.generated_at) ?? new Date().toISOString(),
    limit: asNumber(graph.limit) ?? 5000,
    locations: Array.isArray(graph.locations) ? graph.locations.map(parseGeoLocation).filter((location): location is GeoLocationEntity => location !== null) : [],
    connectedEntities: Array.isArray(graph.connected_entities)
      ? graph.connected_entities.map(parseConnectedEntity).filter((entity): entity is GeoConnectedGraphEntity => entity !== null)
      : [],
    relationships: Array.isArray(graph.relationships)
      ? graph.relationships.map(parseRelationship).filter((relationship): relationship is GeoRelationshipEdge => relationship !== null)
      : [],
  };
}

function parseGeoLocation(value: unknown): GeoLocationEntity | null {
  if (!isRecord(value)) {
    return null;
  }
  const location = value as GeoLocationApiPayload;
  const id = asString(location.id);
  if (id === null) {
    return null;
  }
  return {
    id,
    canonicalName: asString(location.canonical_name) ?? id,
    confidence: asNullableNumber(location.confidence),
    sourceCount: asNullableNumber(location.source_count),
    lastUpdated: asString(location.last_updated),
    latitude: asNullableNumber(location.latitude),
    longitude: asNullableNumber(location.longitude),
  };
}

function parseConnectedEntity(value: unknown): GeoConnectedGraphEntity | null {
  if (!isRecord(value)) {
    return null;
  }
  const entity = value as GeoConnectedEntityApiPayload;
  const id = asString(entity.id);
  const entityType = entity.entity_type === "ORG" || entity.entity_type === "PERSON" ? entity.entity_type : null;
  if (id === null || entityType === null) {
    return null;
  }
  return {
    id,
    entityType,
    canonicalName: asString(entity.canonical_name) ?? id,
    confidence: asNullableNumber(entity.confidence),
    lastUpdated: asString(entity.last_updated),
  };
}

function parseRelationship(value: unknown): GeoRelationshipEdge | null {
  if (!isRecord(value)) {
    return null;
  }
  const relationship = value as GeoRelationshipApiPayload;
  const id = asString(relationship.id);
  if (id === null) {
    return null;
  }
  return {
    id,
    sourceEntityId: asString(relationship.source_entity_id),
    destinationEntityId: asString(relationship.destination_entity_id),
    confidence: asNullableNumber(relationship.confidence),
    validFrom: asString(relationship.valid_from),
    evidenceText: asString(relationship.evidence_text),
  };
}

function emptyGeoGraph(): GeoGraph {
  return { generatedAt: new Date().toISOString(), limit: 5000, locations: [], connectedEntities: [], relationships: [] };
}

function readError(payload: unknown): string {
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  if (isRecord(payload) && typeof payload.detail === "string") {
    return payload.detail;
  }
  return "Unable to load GEO graph.";
}

function hasErrorPayload(payload: unknown): boolean {
  return isRecord(payload) && (typeof payload.error === "string" || typeof payload.detail === "string");
}

function formatConfidence(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function tooltipToneClass(tone: TooltipState["tone"]): string {
  return {
    amber: "border-accent-amber/40",
    blue: "border-accent-blue/40",
    cyan: "border-accent-cyan/40",
    green: "border-accent-green/40",
  }[tone];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asNullableNumber(value: unknown): number | null {
  return asNumber(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
