"use client";

import { useEffect, useState } from "react";

export type GeoSummaryStatus = "loading" | "ready" | "error";

export interface GeoGraphSummary {
  status: GeoSummaryStatus;
  locations: number;
  connectedEntities: number;
  relationships: number;
  generatedAt: string | null;
  error: string | null;
}

const EMPTY_SUMMARY: GeoGraphSummary = {
  status: "loading",
  locations: 0,
  connectedEntities: 0,
  relationships: 0,
  generatedAt: null,
  error: null,
};

export function useGeoGraphSummary(pollIntervalMs = 15000): GeoGraphSummary {
  const [summary, setSummary] = useState<GeoGraphSummary>(EMPTY_SUMMARY);

  useEffect(() => {
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      try {
        const response = await fetch("/api/intelligence/geo?limit=5000", { cache: "no-store" });
        const payload = (await response.json()) as unknown;
        if (hasErrorPayload(payload)) {
          throw new Error(readError(payload));
        }
        if (!response.ok) {
          throw new Error(readError(payload));
        }
        if (!stopped) {
          setSummary(parseGeoSummary(payload));
        }
      } catch (error) {
        if (!stopped) {
          setSummary({
            ...EMPTY_SUMMARY,
            status: "error",
            error: error instanceof Error ? error.message : "GEO graph summary failed.",
          });
        }
      }
    }

    void refresh();
    interval = setInterval(refresh, pollIntervalMs);
    return () => {
      stopped = true;
      if (interval !== null) {
        clearInterval(interval);
      }
    };
  }, [pollIntervalMs]);

  return summary;
}

function parseGeoSummary(payload: unknown): GeoGraphSummary {
  if (!isRecord(payload)) {
    return { ...EMPTY_SUMMARY, status: "error", error: "GEO graph payload was malformed." };
  }
  return {
    status: "ready",
    locations: Array.isArray(payload.locations) ? payload.locations.length : 0,
    connectedEntities: Array.isArray(payload.connected_entities) ? payload.connected_entities.length : 0,
    relationships: Array.isArray(payload.relationships) ? payload.relationships.length : 0,
    generatedAt: typeof payload.generated_at === "string" ? payload.generated_at : null,
    error: null,
  };
}

function readError(payload: unknown): string {
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  if (isRecord(payload) && typeof payload.detail === "string") {
    return payload.detail;
  }
  return "GEO graph summary failed.";
}

function hasErrorPayload(payload: unknown): boolean {
  return isRecord(payload) && (typeof payload.error === "string" || typeof payload.detail === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}