"use client";

import { useEffect, useState } from "react";

export type ServiceKey = "backend" | "redpanda" | "arcadedb" | "llm";
export type ServiceState = "online" | "degraded" | "offline" | "unknown";
export type SystemSummaryState = "online" | "degraded" | "offline" | "loading";

export interface RuntimeServiceStatus {
  key: ServiceKey;
  name: string;
  state: ServiceState;
  detail: string;
  latencyMs: number | null;
  checkedAt: string;
}

export interface SystemStatusSnapshot {
  generatedAt: string | null;
  summary: {
    state: SystemSummaryState;
    online: number;
    degraded: number;
    total: number;
  };
  services: RuntimeServiceStatus[];
  error: string | null;
}

const EMPTY_STATUS: SystemStatusSnapshot = {
  generatedAt: null,
  summary: { state: "loading", online: 0, degraded: 0, total: 4 },
  services: [],
  error: null,
};

export function useSystemStatus(pollIntervalMs = 10000): SystemStatusSnapshot {
  const [snapshot, setSnapshot] = useState<SystemStatusSnapshot>(EMPTY_STATUS);

  useEffect(() => {
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    async function refresh() {
      try {
        const response = await fetch("/api/system/status", { cache: "no-store" });
        const payload = (await response.json()) as unknown;
        if (!response.ok) {
          throw new Error(readError(payload));
        }
        if (!stopped) {
          setSnapshot(parseSystemStatus(payload));
        }
      } catch (error) {
        if (!stopped) {
          setSnapshot({
            ...EMPTY_STATUS,
            summary: { ...EMPTY_STATUS.summary, state: "offline" },
            error: error instanceof Error ? error.message : "System status probe failed.",
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

  return snapshot;
}

function parseSystemStatus(payload: unknown): SystemStatusSnapshot {
  if (!isRecord(payload)) {
    return { ...EMPTY_STATUS, error: "System status payload was malformed." };
  }
  const summary = isRecord(payload.summary) ? payload.summary : {};
  const services = Array.isArray(payload.services) ? payload.services.map(parseService).filter((service): service is RuntimeServiceStatus => service !== null) : [];
  return {
    generatedAt: asString(payload.generatedAt),
    summary: {
      state: parseSummaryState(summary.state),
      online: asNumber(summary.online) ?? 0,
      degraded: asNumber(summary.degraded) ?? 0,
      total: asNumber(summary.total) ?? services.length,
    },
    services,
    error: null,
  };
}

function parseService(value: unknown): RuntimeServiceStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const key = parseServiceKey(value.key);
  if (key === null) {
    return null;
  }
  return {
    key,
    name: asString(value.name) ?? key,
    state: parseServiceState(value.state),
    detail: asString(value.detail) ?? "no detail",
    latencyMs: asNumber(value.latencyMs),
    checkedAt: asString(value.checkedAt) ?? new Date().toISOString(),
  };
}

function parseServiceKey(value: unknown): ServiceKey | null {
  return value === "backend" || value === "redpanda" || value === "arcadedb" || value === "llm" ? value : null;
}

function parseServiceState(value: unknown): ServiceState {
  return value === "online" || value === "degraded" || value === "offline" ? value : "unknown";
}

function parseSummaryState(value: unknown): SystemSummaryState {
  return value === "online" || value === "degraded" || value === "offline" ? value : "loading";
}

function readError(payload: unknown): string {
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  return "System status probe failed.";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}