"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import type { LiveEventConnectionStatus, LiveEventSignal } from "@/types/intelligence";

const DEFAULT_MAX_EVENTS = 500;
const MAX_RECONNECT_DELAY_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 25000;

interface UseLiveEventSignalsOptions {
  maxEvents?: number;
  websocketUrl?: string;
  enabled?: boolean;
}

interface UseLiveEventSignalsResult {
  events: LiveEventSignal[];
  status: LiveEventConnectionStatus;
  lastError: string | null;
  clear: () => void;
}

interface BackendEventEntity {
  id?: unknown;
  entity_type?: unknown;
  confidence?: unknown;
}

interface BackendEventNotification {
  id?: unknown;
  entity?: BackendEventEntity;
  canonical_name?: unknown;
  persisted_at?: unknown;
  source_batch_id?: unknown;
}

export function useLiveEventSignals(options: UseLiveEventSignalsOptions = {}): UseLiveEventSignalsResult {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const websocketUrl = options.websocketUrl ?? buildEventWebSocketUrl();
  const enabled = options.enabled ?? true;
  const [events, setEvents] = useState<LiveEventSignal[]>([]);
  const [status, setStatus] = useState<LiveEventConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const bufferRef = useRef<LiveEventSignal[]>([]);
  const animationFrameRef = useRef<number | null>(null);

  const flushBufferedEvents = useCallback(() => {
    animationFrameRef.current = null;
    const bufferedEvents = bufferRef.current.splice(0).reverse();
    if (bufferedEvents.length === 0) {
      return;
    }

    startTransition(() => {
      setEvents((currentEvents) => {
        const existingIds = new Set(currentEvents.map((event) => event.id));
        const incomingEvents = bufferedEvents.filter((event) => !existingIds.has(event.id));
        if (incomingEvents.length === 0) {
          return currentEvents;
        }
        return incomingEvents.concat(currentEvents).slice(0, maxEvents);
      });
    });
  }, [maxEvents]);

  const scheduleFlush = useCallback(() => {
    if (animationFrameRef.current === null) {
      animationFrameRef.current = window.requestAnimationFrame(flushBufferedEvents);
    }
  }, [flushBufferedEvents]);

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      setLastError("Intelligence API offline.");
      return;
    }

    let stopped = false;
    let reconnectAttempt = 0;
    let websocket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    function clearTimers() {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function scheduleReconnect() {
      if (stopped) {
        return;
      }
      const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      clearTimers();
      setStatus("connecting");
      websocket = new WebSocket(websocketUrl);

      websocket.addEventListener("open", () => {
        reconnectAttempt = 0;
        setStatus("open");
        setLastError(null);
        heartbeatTimer = setInterval(() => {
          if (websocket?.readyState === WebSocket.OPEN) {
            websocket.send("ping");
          }
        }, HEARTBEAT_INTERVAL_MS);
      });

      websocket.addEventListener("message", (event: MessageEvent) => {
        const signal = parseEventSignal(event.data);
        if (signal === null) {
          return;
        }
        bufferRef.current.push(signal);
        scheduleFlush();
      });

      websocket.addEventListener("error", () => {
        setStatus("error");
        setLastError("Live event stream connection failed.");
      });

      websocket.addEventListener("close", () => {
        clearTimers();
        setStatus((currentStatus) => (currentStatus === "error" ? "error" : "closed"));
        scheduleReconnect();
      });
    }

    connect();

    return () => {
      stopped = true;
      clearTimers();
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      websocket?.close();
    };
  }, [enabled, scheduleFlush, websocketUrl]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, status, lastError, clear };
}

function buildEventWebSocketUrl(): string {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
  const url = new URL("/intelligence/events", apiBaseUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}

function parseEventSignal(data: unknown): LiveEventSignal | null {
  if (typeof data !== "string") {
    return null;
  }

  let payload: BackendEventNotification;
  try {
    payload = JSON.parse(data) as BackendEventNotification;
  } catch {
    return null;
  }

  const notificationId = asString(payload.id);
  const entityId = asString(payload.entity?.id);
  const eventType = asString(payload.entity?.entity_type) ?? "EVENT";
  const confidence = asNumber(payload.entity?.confidence);
  const timestamp = asString(payload.persisted_at);
  if (notificationId === null || entityId === null || confidence === null || timestamp === null) {
    return null;
  }

  return {
    id: notificationId,
    eventEntityId: entityId,
    eventType,
    canonicalName: asString(payload.canonical_name) ?? "Unnamed event",
    timestamp,
    confidence: clamp(confidence, 0, 1),
    sourceBatchId: asString(payload.source_batch_id) ?? "unknown",
    receivedAt: new Date().toISOString(),
  };
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
