"use client";

import { useEffect, useState } from "react";

export type PulseSource = "hackernews" | "reddit" | "gdelt";

export interface FeedPulseDetail {
  source: PulseSource;
  items: number;
  entities?: number;
  query?: string;
  ok: boolean;
}

export interface ActivityEntry {
  id: string;
  at: string;
  kind: "fetch" | "extract" | "lead" | "lookup";
  text: string;
  tone: "green" | "amber" | "rose" | "cyan" | "blue";
}

export interface LivePulse {
  totalItems: number;
  totalEntities: number;
  sourcesActive: number;
  lastFetchedAt: string | null;
  lastSource: PulseSource | null;
  bySource: Record<PulseSource, { items: number; entities: number; lastAt: string | null; ok: boolean }>;
  leadCount: number;
  urgentCount: number;
  activity: ActivityEntry[];
}

const EMPTY_BY_SOURCE: LivePulse["bySource"] = {
  hackernews: { items: 0, entities: 0, lastAt: null, ok: false },
  reddit: { items: 0, entities: 0, lastAt: null, ok: false },
  gdelt: { items: 0, entities: 0, lastAt: null, ok: false },
};

function readLeadCounts(): { leadCount: number; urgentCount: number } {
  if (typeof window === "undefined") {
    return { leadCount: 0, urgentCount: 0 };
  }
  try {
    const raw = window.localStorage.getItem("osint.localLeads");
    if (raw === null) {
      return { leadCount: 0, urgentCount: 0 };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { leadCount: 0, urgentCount: 0 };
    }
    let urgent = 0;
    for (const entry of parsed) {
      if (entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).priority === "urgent") {
        urgent += 1;
      }
    }
    return { leadCount: parsed.length, urgentCount: urgent };
  } catch {
    return { leadCount: 0, urgentCount: 0 };
  }
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useLivePulse(): LivePulse {
  const [bySource, setBySource] = useState<LivePulse["bySource"]>(EMPTY_BY_SOURCE);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [leadState, setLeadState] = useState<{ leadCount: number; urgentCount: number }>({ leadCount: 0, urgentCount: 0 });
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [lastSource, setLastSource] = useState<PulseSource | null>(null);

  useEffect(() => {
    setLeadState(readLeadCounts());

    function pushActivity(entry: ActivityEntry, clearFailedSource?: PulseSource) {
      setActivity((current) => [
        entry,
        ...current.filter((item) => clearFailedSource === undefined || item.text !== `Fetch failed for ${sourceLabel(clearFailedSource)}`),
      ].slice(0, 12));
    }

    function onFeedPulse(event: Event) {
      const detail = (event as CustomEvent<FeedPulseDetail>).detail;
      if (!detail || (detail.source !== "hackernews" && detail.source !== "reddit" && detail.source !== "gdelt")) {
        return;
      }
      const at = new Date().toISOString();
      setBySource((current) => ({
        ...current,
        [detail.source]: {
          items: detail.items,
          entities: detail.entities ?? current[detail.source].entities,
          lastAt: at,
          ok: detail.ok,
        },
      }));
      setLastFetchedAt(at);
      setLastSource(detail.source);
      if (typeof detail.entities === "number" && detail.entities > 0) {
        pushActivity({
          id: makeId(),
          at,
          kind: "extract",
          text: `Extracted ${detail.entities} entities from ${sourceLabel(detail.source)}`,
          tone: "blue",
        });
      } else {
        pushActivity({
          id: makeId(),
          at,
          kind: "fetch",
          text: detail.ok
            ? `Fetched ${detail.items} items from ${sourceLabel(detail.source)}${detail.query ? ` · "${detail.query}"` : ""}`
            : `Fetch failed for ${sourceLabel(detail.source)}`,
          tone: detail.ok ? "green" : "rose",
        }, detail.ok ? detail.source : undefined);
      }
    }

    function onLead(event: Event) {
      const detail = (event as CustomEvent<{ text?: string; source?: string }>).detail;
      const text = typeof detail?.text === "string" ? detail.text : "";
      const source = typeof detail?.source === "string" ? detail.source : "feed";
      pushActivity({
        id: makeId(),
        at: new Date().toISOString(),
        kind: "lead",
        text: `Promoted to lead · ${source}${text ? ` · ${text.slice(0, 60)}` : ""}`,
        tone: "cyan",
      });
      setLeadState(readLeadCounts());
    }

    function onLookup(event: Event) {
      const detail = (event as CustomEvent<{ term?: string; found?: boolean }>).detail;
      const term = typeof detail?.term === "string" ? detail.term : "";
      pushActivity({
        id: makeId(),
        at: new Date().toISOString(),
        kind: "lookup",
        text: detail?.found ? `Wikipedia hit · ${term}` : `Wikipedia miss · ${term}`,
        tone: detail?.found ? "blue" : "amber",
      });
    }

    function onStorage(event: StorageEvent) {
      if (event.key === "osint.localLeads" || event.key === null) {
        setLeadState(readLeadCounts());
      }
    }

    window.addEventListener("osint:feed-pulse", onFeedPulse as EventListener);
    window.addEventListener("osint:add-lead", onLead as EventListener);
    window.addEventListener("osint:lookup", onLookup as EventListener);
    window.addEventListener("storage", onStorage);

    const interval = window.setInterval(() => setLeadState(readLeadCounts()), 4000);
    return () => {
      window.removeEventListener("osint:feed-pulse", onFeedPulse as EventListener);
      window.removeEventListener("osint:add-lead", onLead as EventListener);
      window.removeEventListener("osint:lookup", onLookup as EventListener);
      window.removeEventListener("storage", onStorage);
      window.clearInterval(interval);
    };
  }, []);

  const totalItems = bySource.hackernews.items + bySource.reddit.items + bySource.gdelt.items;
  const totalEntities = bySource.hackernews.entities + bySource.reddit.entities + bySource.gdelt.entities;
  const sourcesActive = (["hackernews", "reddit", "gdelt"] as PulseSource[]).filter((s) => bySource[s].ok && bySource[s].items > 0).length;

  return {
    totalItems,
    totalEntities,
    sourcesActive,
    lastFetchedAt,
    lastSource,
    bySource,
    leadCount: leadState.leadCount,
    urgentCount: leadState.urgentCount,
    activity,
  };
}

function sourceLabel(source: PulseSource): string {
  if (source === "hackernews") return "open web";
  if (source === "reddit") return "community";
  return "news monitor";
}
