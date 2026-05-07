"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Notification types ────────────────────────────────────────────────────────
export type NotifKind =
  | "signal_burst"    // rapid ingestion
  | "entity_found"    // notable entity extracted
  | "threat_alert"    // CVE / IP / HASH / malware
  | "source_error"    // feed failure
  | "geo_ping"        // new GEO entity
  | "extraction_done" // entity extraction finished
  | "rate_spike"      // unusual velocity
  | "lookup_hit";     // dossier found

export type NotifSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface OsintNotification {
  id: string;
  kind: NotifKind;
  severity: NotifSeverity;
  title: string;
  detail: string;
  at: string;          // ISO timestamp
  read: boolean;
  source?: string;
  entity?: string;
}

// ─── DOM event shapes ──────────────────────────────────────────────────────────
interface FeedPulseDetail {
  source: string;
  items: number;
  entities?: number;
  ok: boolean;
  query?: string;
}

interface EntitiesExtractedDetail {
  entities: Array<{ kind: string; value: string; count: number; confidence?: number }>;
}

interface LookupDetail {
  term: string;
  found: boolean;
  sources: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const THREAT_KINDS = new Set(["CVE", "IP", "HASH", "EMAIL"]);
const MAX_NOTIFS = 80;
const VELOCITY_SPIKE_THRESHOLD = 5; // >= N fetches in last 60s

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function now(): string {
  return new Date().toISOString();
}

const SEVERITY_ORDER: Record<NotifSeverity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

export function sortBySeverity(a: OsintNotification, b: OsintNotification): number {
  const diff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (diff !== 0) return diff;
  return new Date(b.at).getTime() - new Date(a.at).getTime();
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useNotifications() {
  const [notifications, setNotifications] = useState<OsintNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const fetchTimestampsRef = useRef<number[]>([]);
  const lastBurstRef = useRef<number>(0);
  const lastSpikeRef = useRef<number>(0);
  const notifCountRef = useRef<Map<string, number>>(new Map());

  const push = useCallback((notif: Omit<OsintNotification, "id" | "read" | "at">) => {
    const full: OsintNotification = { ...notif, id: makeId(), read: false, at: now() };
    setNotifications((prev) => [full, ...prev].slice(0, MAX_NOTIFS));
    setUnreadCount((n) => n + 1);
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
    setUnreadCount((n) => Math.max(0, n - 1));
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => {
      const notif = prev.find((n) => n.id === id);
      if (notif && !notif.read) setUnreadCount((n) => Math.max(0, n - 1));
      return prev.filter((n) => n.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    setUnreadCount(0);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function handleFeedPulse(ev: Event) {
      const d = (ev as CustomEvent<FeedPulseDetail>).detail;

      // Source error
      if (!d.ok) {
        push({
          kind: "source_error",
          severity: "high",
          title: `Source offline: ${d.source.toUpperCase()}`,
          detail: `Feed "${d.source}" returned no results — possible upstream failure or rate limit.`,
          source: d.source,
        });
        return;
      }

      // Velocity tracking
      const ts = Date.now();
      fetchTimestampsRef.current = [...fetchTimestampsRef.current.slice(-29), ts];
      const windowStart = ts - 60_000;
      const recentCount = fetchTimestampsRef.current.filter((t) => t > windowStart).length;
      if (recentCount >= VELOCITY_SPIKE_THRESHOLD && ts - lastSpikeRef.current > 120_000) {
        lastSpikeRef.current = ts;
        push({
          kind: "rate_spike",
          severity: "medium",
          title: "Signal velocity spike",
          detail: `${recentCount} feed fetches in the last 60s — unusual ingestion rate detected.`,
          source: d.source,
        });
      }

      // Signal burst
      if (d.items >= 25 && ts - lastBurstRef.current > 90_000) {
        lastBurstRef.current = ts;
        push({
          kind: "signal_burst",
          severity: "low",
          title: `Signal burst: ${d.items} items`,
          detail: `Source "${d.source}" returned ${d.items} signals for query "${d.query ?? "—"}".`,
          source: d.source,
        });
      }
    }

    function handleEntitiesExtracted(ev: Event) {
      const d = (ev as CustomEvent<EntitiesExtractedDetail>).detail;
      const entities = d.entities ?? [];

      // Threat entities — CVE, IP, HASH
      const threats = entities.filter((e) => THREAT_KINDS.has(e.kind));
      for (const threat of threats.slice(0, 3)) {
        const key = `${threat.kind}:${threat.value}`;
        const prev = notifCountRef.current.get(key) ?? 0;
        if (prev === 0) {
          notifCountRef.current.set(key, 1);
          push({
            kind: "threat_alert",
            severity: threat.kind === "CVE" ? "critical" : "high",
            title: `${threat.kind} indicator detected`,
            detail: `${threat.kind}: ${threat.value} · count ${threat.count}${typeof threat.confidence === "number" ? ` · conf ${(threat.confidence * 100).toFixed(0)}%` : ""}`,
            entity: threat.value,
          });
        }
      }

      // High-confidence GEO entity
      const geos = entities.filter(
        (e) => e.kind === "GEO" && typeof e.confidence === "number" && e.confidence >= 0.75,
      );
      if (geos.length > 0 && geos[0] !== undefined) {
        const geo = geos[0];
        const key = `GEO:${geo.value}`;
        if (!(notifCountRef.current.has(key))) {
          notifCountRef.current.set(key, 1);
          push({
            kind: "geo_ping",
            severity: "info",
            title: `Geo-intelligence: ${geo.value}`,
            detail: `High-confidence GEO entity "${geo.value}" extracted from latest signal batch (${entities.length} total entities).`,
            entity: geo.value,
          });
        }
      }

      // Extraction complete summary
      if (entities.length >= 5) {
        const kindCounts = entities.reduce<Record<string, number>>((acc, e) => {
          acc[e.kind] = (acc[e.kind] ?? 0) + 1;
          return acc;
        }, {});
        const summary = Object.entries(kindCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ");
        push({
          kind: "extraction_done",
          severity: "info",
          title: `${entities.length} entities extracted`,
          detail: `NER pass completed: ${summary}.`,
        });
      }
    }

    function handleLookup(ev: Event) {
      const d = (ev as CustomEvent<LookupDetail>).detail;
      if (d.found) {
        push({
          kind: "lookup_hit",
          severity: "medium",
          title: `Intel dossier: ${d.term}`,
          detail: `Entity dossier found across ${d.sources} source${d.sources !== 1 ? "s" : ""} for "${d.term}".`,
          entity: d.term,
        });
      }
    }

    window.addEventListener("osint:feed-pulse", handleFeedPulse);
    window.addEventListener("osint:entities-extracted", handleEntitiesExtracted);
    window.addEventListener("osint:lookup", handleLookup);

    return () => {
      window.removeEventListener("osint:feed-pulse", handleFeedPulse);
      window.removeEventListener("osint:entities-extracted", handleEntitiesExtracted);
      window.removeEventListener("osint:lookup", handleLookup);
    };
  }, [push]);

  return { notifications, unreadCount, push, markRead, markAllRead, dismiss, clearAll };
}
