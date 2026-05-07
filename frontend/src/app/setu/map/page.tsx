"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { ProjectPicker, useSetuProjects } from "@/components/setu/project-context";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { useAsync } from "@/hooks/use-async";
import { setuClient } from "@/lib/setu-client";
import type { SetuSignal } from "@/types/setu";

// India-centred default view.
const DEFAULT_CENTER: [number, number] = [79.0, 22.5];
const DEFAULT_ZOOM = 4.2;

// Free OSM raster tiles (no API key). Replace with a vector style if you ship a tile server.
const RASTER_STYLE = {
  version: 8 as const,
  sources: {
    osm: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
      maxzoom: 19,
    },
  },
  layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
};

interface ClusterFeatureProps {
  signal_id: string;
  title: string;
  explanation: string;
  observed: number;
  expected: number;
  p_value: number;
  log_likelihood: number;
  radius_deg: number;
  status: string;
  district: string;
}

function buildGeoJSON(
  clusters: SetuSignal[],
): GeoJSON.FeatureCollection<GeoJSON.Point, ClusterFeatureProps> {
  return {
    type: "FeatureCollection",
    features: clusters
      .filter((s) => s.cluster_stat)
      .map((s) => {
        const stat = s.cluster_stat!;
        return {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: [stat.centroid_lon, stat.centroid_lat],
          },
          properties: {
            signal_id: s.id,
            title: s.title,
            explanation: s.explanation,
            observed: stat.observed,
            expected: stat.expected,
            p_value: stat.p_value,
            log_likelihood: stat.log_likelihood,
            radius_deg: stat.radius_deg,
            status: s.status,
            district: s.district ?? "",
          },
        };
      }),
  };
}

export default function SetuMapPage() {
  const { selectedProjectId } = useSetuProjects();
  const clusterQuery = useAsync(
    () =>
      selectedProjectId
        ? setuClient.listSignals(selectedProjectId, { kind: "cluster", limit: 100 })
        : Promise.resolve([]),
    [selectedProjectId],
  );

  const clusters = useMemo(
    () => (clusterQuery.data ?? []).filter((s) => s.cluster_stat),
    [clusterQuery.data],
  );

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">District Cluster Map</h1>
          <p className="text-xs text-muted">
            Geographic clusters detected via Poisson grid scan. Tiles © OpenStreetMap; circles
            scaled by observed count, coloured by p-value.
          </p>
        </div>
        <ProjectPicker />
      </div>

      {!selectedProjectId && <p className="text-sm text-muted">Select a project to view clusters.</p>}
      {selectedProjectId && clusterQuery.loading && <p className="text-sm text-muted">loading…</p>}
      {selectedProjectId && !clusterQuery.loading && clusters.length === 0 && (
        <p className="text-sm text-muted">No cluster signals yet.</p>
      )}

      {selectedProjectId && <ClusterMap clusters={clusters} />}

      <div className="grid gap-3 md:grid-cols-2">
        {clusters.map((signal) => {
          const stat = signal.cluster_stat!;
          return (
            <Panel key={signal.id}>
              <PanelHeader>
                <PanelTitle>{signal.title}</PanelTitle>
              </PanelHeader>
              <PanelBody>
                <p className="text-sm text-foreground">{signal.explanation}</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <Row k="centroid" v={`${stat.centroid_lat.toFixed(3)}, ${stat.centroid_lon.toFixed(3)}`} />
                  <Row k="radius°" v={stat.radius_deg.toFixed(2)} />
                  <Row k="observed" v={String(stat.observed)} />
                  <Row k="expected" v={stat.expected.toFixed(2)} />
                  <Row k="log-likelihood" v={stat.log_likelihood.toFixed(2)} />
                  <Row k="p-value" v={stat.p_value.toFixed(4)} />
                  {signal.district && <Row k="district" v={signal.district} />}
                  <Row k="status" v={signal.status} />
                </dl>
              </PanelBody>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

function ClusterMap({ clusters }: { clusters: SetuSignal[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Holds the maplibre-gl Map instance. Typed as `any` because we import maplibre-gl
  // dynamically inside an effect to avoid SSR/window references at build time.
  const mapRef = useRef<any>(null);
  const readyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Initialise the map exactly once.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let map: any = null;
    (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        // Side-effect CSS import — Next bundles via PostCSS.
        await import("maplibre-gl/dist/maplibre-gl.css");
        if (cancelled || !containerRef.current) return;
        map = new maplibre.Map({
          container: containerRef.current,
          style: RASTER_STYLE as any,
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
        });
        map.addControl(new maplibre.NavigationControl({ visualizePitch: false }), "top-right");
        map.on("load", () => {
          if (cancelled) return;
          map.addSource("clusters", {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
          map.addLayer({
            id: "cluster-circles",
            type: "circle",
            source: "clusters",
            paint: {
              "circle-radius": [
                "interpolate", ["linear"], ["get", "observed"],
                0, 6,
                10, 12,
                100, 24,
                1000, 36,
              ],
              "circle-color": [
                "interpolate", ["linear"], ["get", "p_value"],
                0.0, "#dc2626",
                0.01, "#f97316",
                0.05, "#eab308",
                0.2, "#64748b",
              ],
              "circle-opacity": 0.75,
              "circle-stroke-width": 1,
              "circle-stroke-color": "#0f172a",
            },
          });
          map.on("click", "cluster-circles", (e: any) => {
            const feat = e.features?.[0];
            if (!feat) return;
            const p = feat.properties as ClusterFeatureProps;
            const html = `
              <div style="font-family:system-ui;font-size:12px;max-width:240px;color:#0f172a">
                <div style="font-weight:600;margin-bottom:4px">${escapeHtml(p.title)}</div>
                <div style="margin-bottom:4px">${escapeHtml(p.explanation)}</div>
                <div>observed: <b>${p.observed}</b> · expected: <b>${Number(p.expected).toFixed(2)}</b></div>
                <div>p-value: <b>${Number(p.p_value).toFixed(4)}</b> · LLR: <b>${Number(p.log_likelihood).toFixed(2)}</b></div>
                <div>status: <b>${escapeHtml(p.status)}</b>${p.district ? ` · district: <b>${escapeHtml(p.district)}</b>` : ""}</div>
              </div>`;
            new maplibre.Popup({ closeButton: true })
              .setLngLat(feat.geometry.coordinates as [number, number])
              .setHTML(html)
              .addTo(map);
          });
          map.on("mouseenter", "cluster-circles", () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", "cluster-circles", () => {
            map.getCanvas().style.cursor = "";
          });
          readyRef.current = true;
          mapRef.current = map;
          // Push initial data, in case clusters arrived before load fired.
          const src = map.getSource("clusters");
          if (src && "setData" in src) {
            (src as any).setData(buildGeoJSON(clusters));
            fitToFeatures(map, clusters);
          }
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      readyRef.current = false;
      if (map) map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update the GeoJSON source whenever clusters change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const src = map.getSource("clusters");
    if (!src) return;
    src.setData(buildGeoJSON(clusters));
    fitToFeatures(map, clusters);
  }, [clusters]);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Cluster map</PanelTitle>
      </PanelHeader>
      <PanelBody>
        {error && <p className="text-xs text-red-500">map failed to load: {error}</p>}
        <div
          ref={containerRef}
          className="h-[480px] w-full overflow-hidden rounded-md border border-border bg-muted/10"
          aria-label="District cluster map"
        />
      </PanelBody>
    </Panel>
  );
}

function fitToFeatures(map: any, clusters: SetuSignal[]) {
  const coords = clusters
    .map((s) => s.cluster_stat)
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => [s.centroid_lon, s.centroid_lat] as [number, number]);
  if (coords.length === 0) return;
  if (coords.length === 1) {
    map.easeTo({ center: coords[0], zoom: Math.max(map.getZoom(), 6) });
    return;
  }
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const sw: [number, number] = [Math.min(...lons), Math.min(...lats)];
  const ne: [number, number] = [Math.max(...lons), Math.max(...lats)];
  map.fitBounds([sw, ne], { padding: 48, maxZoom: 8, duration: 600 });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono text-foreground">{v}</dd>
    </>
  );
}
