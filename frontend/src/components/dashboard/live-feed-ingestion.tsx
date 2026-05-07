"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  Database,
  ExternalLink,
  Fingerprint,
  Globe2,
  Loader2,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { SourceMetric } from "@/app/api/feeds/all/route";
import type { FeedItem } from "@/app/api/feeds/hackernews/route";
import type { EntityKind, ExtractedEntity } from "@/app/api/extract/entities/route";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";

type FeedSource = "hackernews" | "reddit" | "gdelt" | "pubmed" | "who" | "all";

interface SourceConfig {
  key: FeedSource;
  label: string;
  defaultQuery: string;
  buildUrl: (query: string) => string;
  hint: string;
}

const SOURCES: Record<FeedSource, SourceConfig> = {
  all: {
    key: "all",
    label: "All Sources",
    defaultQuery: "outbreak OR adverse event OR vaccine OR epidemic",
    buildUrl: (query) => `/api/feeds/all?q=${encodeURIComponent(query)}&limit=60`,
    hint: "parallel multi-source crawl · real-time",
  },
  hackernews: {
    key: "hackernews",
    label: "Open Web",
    defaultQuery: "public health OR vaccine OR hospital",
    buildUrl: (query) => `/api/feeds/hackernews?q=${encodeURIComponent(query)}&limit=20`,
    hint: "open-web sandbox adapter · relevance filtered",
  },
  reddit: {
    key: "reddit",
    label: "Community",
    defaultQuery: "vaccine side effect OR fever OR rash",
    buildUrl: (query) => `/api/feeds/reddit?q=${encodeURIComponent(query || "vaccine side effect OR fever OR rash")}&sort=new&limit=20`,
    hint: "public community adapter · relevance filtered",
  },
  gdelt: {
    key: "gdelt",
    label: "News Monitor",
    defaultQuery: "adverse event OR vaccine OR outbreak",
    buildUrl: (query) => `/api/feeds/gdelt?q=${encodeURIComponent(query)}&limit=25`,
    hint: "news monitor adapter · local fallback",
  },
  pubmed: {
    key: "pubmed",
    label: "Biomedical",
    defaultQuery: "outbreak surveillance OR disease monitoring",
    buildUrl: (query) => `/api/feeds/pubmed?q=${encodeURIComponent(query)}&limit=20`,
    hint: "NCBI PubMed live search · biomedical literature",
  },
  who: {
    key: "who",
    label: "WHO/CDC",
    defaultQuery: "disease outbreak",
    buildUrl: (query) => `/api/feeds/who?q=${encodeURIComponent(query)}&limit=40`,
    hint: "WHO/CDC/ECDC live RSS · outbreak alerts",
  },
};

// Tab display order
const SOURCE_TABS: FeedSource[] = ["all", "hackernews", "reddit", "gdelt", "pubmed", "who"];
// Sources included in background heartbeat sweep (lightweight sources only)
const HEARTBEAT_SOURCES: FeedSource[] = ["hackernews", "reddit", "gdelt"];

// Chart color palette per source
const CHART_COLORS: Record<string, string> = {
  all: "#22d3ee",
  hackernews: "#fb923c",
  reddit: "#f87171",
  gdelt: "#60a5fa",
  pubmed: "#34d399",
  who: "#a78bfa",
  default: "#94a3b8",
};

const KIND_COLORS: Partial<Record<EntityKind, string>> = {
  ORG: "#22d3ee",
  PERSON: "#60a5fa",
  GEO: "#34d399",
  EVENT: "#fbbf24",
  CVE: "#f87171",
  IP: "#fb7185",
  URL: "#f59e0b",
  EMAIL: "#fcd34d",
  HASH: "#e11d48",
  MONEY: "#86efac",
  DATE: "#93c5fd",
};

interface SignalPoint {
  label: string;
  count: number;
}

type SourceStatus = "hit" | "modeled" | "miss" | "error" | "scoped";

interface DossierSource {
  id: string;
  name: string;
  category: string;
  status: SourceStatus;
  confidence: number;
  title: string;
  description: string;
  url: string | null;
}

interface DossierMention {
  source: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  detail: string;
}

interface EntityDossier {
  found: boolean;
  term: string;
  normalized: string;
  kind: EntityKind;
  title: string;
  summary: string;
  confidence: number;
  sourceCount: number;
  generatedAt: string;
  sources: DossierSource[];
  mentions: DossierMention[];
  graph: {
    entities: unknown[];
    relationships: unknown[];
  };
}

interface SelectedEntity {
  value: string;
  kind: EntityKind;
  count: number;
}

interface ExtractionRuntime {
  engine: string;
  model: string;
  fallback: boolean;
  fallbackReason?: string | undefined;
}

const ENTITY_TONE: Record<EntityKind, "cyan" | "blue" | "amber" | "green" | "rose"> = {
  PERSON: "blue",
  ORG: "cyan",
  GEO: "green",
  EVENT: "amber",
  URL: "amber",
  IP: "rose",
  EMAIL: "amber",
  HASH: "rose",
  MONEY: "amber",
  DATE: "blue",
  CVE: "rose",
};

const KIND_ORDER: EntityKind[] = ["ORG", "PERSON", "GEO", "EVENT", "CVE", "IP", "URL", "EMAIL", "HASH", "MONEY", "DATE"];

interface LiveFeedIngestionProps {
  onPromote?: (lead: { text: string; source: string }) => void;
}

export function LiveFeedIngestion({ onPromote }: LiveFeedIngestionProps) {
  const [source, setSource] = useState<FeedSource>("all");
  const [query, setQuery] = useState<string>(SOURCES.all.defaultQuery);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedNotice, setFeedNotice] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [fetchedQuery, setFetchedQuery] = useState<string | null>(null);
  const [fetchedSource, setFetchedSource] = useState<FeedSource | null>(null);
  const [sourceMetrics, setSourceMetrics] = useState<SourceMetric[] | null>(null);
  const [entities, setEntities] = useState<ExtractedEntity[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [extractedAt, setExtractedAt] = useState<string | null>(null);
  const [extractionRuntime, setExtractionRuntime] = useState<ExtractionRuntime | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(null);
  const [dossier, setDossier] = useState<EntityDossier | null>(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const signalTimelineRef = useRef<SignalPoint[]>([]);
  const [signalTimeline, setSignalTimeline] = useState<SignalPoint[]>([]);

  // Core extraction logic — accepts items directly so it can be called before React re-renders state
  const doExtract = useCallback(async (sourceItems: FeedItem[], activeQuery: string) => {
    if (sourceItems.length === 0) return;
    setExtracting(true);
    try {
      const queryTerms = activeQuery
        .toLowerCase()
        .split(/\s+/)
        .filter(
          (w) =>
            w.length > 3 &&
            !["that", "this", "with", "from", "about", "into", "over", "under", "after", "before", "while", "when", "where", "what", "which", "who", "how", "why", "then", "there"].includes(w),
        );
      const relevantItems =
        queryTerms.length > 0
          ? sourceItems.filter((item) => {
              const t = (item.title ?? "").toLowerCase();
              return queryTerms.some((w) => t.includes(w));
            })
          : sourceItems;
      const toExtract = relevantItems.length >= 3 ? relevantItems : sourceItems;
      const text = toExtract
        .map((item) => `${item.title}${item.url ? ` (${item.url})` : ""}`)
        .join("\n");
      const extractAbort = new AbortController();
      const extractTimer = setTimeout(() => extractAbort.abort(), 30_000);
      let response: Response;
      try {
        response = await fetch("/api/extract/entities", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, query: activeQuery }),
          signal: extractAbort.signal,
        });
      } finally {
        clearTimeout(extractTimer);
      }
      const payload = (await response.json()) as { entities?: ExtractedEntity[]; engine?: string; model?: string; fallback?: boolean; fallbackReason?: string };
      const list = payload.entities ?? [];
      setEntities(list);
      if (typeof window !== "undefined" && list.length > 0) {
        window.dispatchEvent(new CustomEvent("osint:entities-extracted", { detail: { entities: list } }));
      }
      setExtractedAt(new Date().toISOString());
      setExtractionRuntime({
        engine: payload.engine ?? "unknown",
        model: payload.model ?? "unknown",
        fallback: payload.fallback === true,
        fallbackReason: payload.fallbackReason,
      });
      const qLower = activeQuery.toLowerCase();
      const primary =
        list.find((e) => qLower.includes(e.value.toLowerCase())) ??
        list.find((entity) => entity.kind === "EVENT") ??
        list.find((entity) => entity.kind === "ORG" || entity.kind === "CVE" || entity.kind === "GEO") ??
        list[0];
      if (primary) {
        void lookupEntityFn(primary);
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("osint:feed-pulse", {
          detail: { source, items: sourceItems.length, entities: list, ok: true, query: activeQuery },
        }));
      }
    } catch (err) {
      setEntities([]);
      const reason = err instanceof Error
        ? (err.name === "AbortError" ? "extraction timed out" : err.message)
        : "fetch failed";
      setExtractionRuntime({ engine: "none", model: "none", fallback: true, fallbackReason: reason });
    } finally {
      setExtracting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const refresh = useCallback(
    async (nextSource: FeedSource, nextQuery: string, silent = false) => {
      setLoading(true);
      setError(null);
      setFeedNotice(null);
      try {
        const response = await fetch(SOURCES[nextSource].buildUrl(nextQuery), { cache: "no-store" });
        const payload = (await response.json()) as { items?: FeedItem[]; error?: string; notice?: string | null; scanned?: number; sources?: SourceMetric[] };
        if (!response.ok) {
          setItems([]);
          setError(payload.error ?? `request failed (${response.status})`);
          setFeedNotice(null);
          setSourceMetrics(null);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("osint:feed-pulse", {
              detail: { source: nextSource, items: 0, ok: false, query: nextQuery },
            }));
          }
          return;
        }
        const list = payload.items ?? [];
        setItems(list);
        setSourceMetrics(payload.sources ?? null);
        if (payload.sources && payload.sources.length > 0 && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("osint:source-metrics", { detail: { sources: payload.sources } }));
        }
        setFeedNotice(payload.notice ?? (payload.scanned !== undefined ? `Scanned ${payload.scanned} upstream records with local relevance checks.` : null));
        setFetchedAt(new Date().toISOString());
        setFetchedQuery(nextQuery);
        setFetchedSource(nextSource);

        // Accumulate signal timeline
        const point: SignalPoint = { label: new Date().toLocaleTimeString(), count: list.length };
        signalTimelineRef.current = [...signalTimelineRef.current.slice(-19), point];
        setSignalTimeline([...signalTimelineRef.current]);

        if (!silent) {
          setEntities([]);
          setExtractedAt(null);
          setSelectedEntity(null);
          setDossier(null);
          // Auto-extract immediately after user-triggered fetch
          if (list.length > 0) {
            void doExtract(list, nextQuery);
          }
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("osint:feed-pulse", {
            detail: { source: nextSource, items: list.length, ok: true, query: nextQuery },
          }));
        }
      } catch (err) {
        setItems([]);
        setError(err instanceof Error ? err.message : "fetch failed");
        setFeedNotice(null);
        setSourceMetrics(null);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("osint:feed-pulse", {
            detail: { source: nextSource, items: 0, ok: false, query: nextQuery },
          }));
        }
      } finally {
        setLoading(false);
      }
    },
    [doExtract],
  );

  useEffect(() => {
    void refresh(source, query);
    // initial load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    const id = window.setInterval(() => {
      void refresh(source, query, true);
    }, 60000);
    return () => window.clearInterval(id);
  }, [autoRefresh, source, query, refresh]);

  // Silent multi-source heartbeat: keep ALL feeds (not just the visible tab) fresh
  // so the Live Ops Briefing doesn't show one source as "57m ago / idle".
  useEffect(() => {
    if (!autoRefresh) {
      return;
    }
    let cancelled = false;
    async function sweepOne(key: FeedSource) {
      const cfg = SOURCES[key];
      try {
        const response = await fetch(cfg.buildUrl(cfg.defaultQuery), { cache: "no-store" });
        const payload = (await response.json()) as { items?: FeedItem[] };
        if (cancelled || typeof window === "undefined") return;
        const count = response.ok ? (payload.items ?? []).length : 0;
        window.dispatchEvent(new CustomEvent("osint:feed-pulse", {
          detail: { source: key, items: count, ok: response.ok, query: cfg.defaultQuery },
        }));
      } catch {
        if (cancelled || typeof window === "undefined") return;
        window.dispatchEvent(new CustomEvent("osint:feed-pulse", {
          detail: { source: key, items: 0, ok: false, query: cfg.defaultQuery },
        }));
      }
    }
    async function sweepAll() {
      await Promise.all(HEARTBEAT_SOURCES.filter((k) => k !== source).map(sweepOne));
    }
    void sweepAll();
    const id = window.setInterval(() => { void sweepAll(); }, 90000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [autoRefresh, source]);

  function handleSourceChange(next: FeedSource) {
    setSource(next);
    const nextQuery = SOURCES[next].defaultQuery;
    setQuery(nextQuery);
    void refresh(next, nextQuery);
  }

  async function handleExtract() {
    await doExtract(items, fetchedQuery ?? query);
  }

  async function lookupEntityFn(entity: ExtractedEntity) {
    setSelectedEntity({ value: entity.value, kind: entity.kind, count: entity.count });
    setDossier(null);
    setDossierLoading(true);
    try {
      const response = await fetch(`/api/lookup/entity?q=${encodeURIComponent(entity.value)}&kind=${encodeURIComponent(entity.kind)}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`dossier request failed (${response.status})`);
      }
      const payload = (await response.json()) as EntityDossier;
      setDossier(payload);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("osint:lookup", {
          detail: { term: entity.value, found: payload.found, sources: payload.sourceCount },
        }));
      }
    } catch {
      setDossier(buildClientDossierFallback(entity));
    } finally {
      setDossierLoading(false);
    }
  }

  async function lookupEntity(entity: ExtractedEntity) {
    await lookupEntityFn(entity);
  }

  const grouped = useMemo(() => groupEntities(entities), [entities]);
  const queryDirty = fetchedQuery !== null && (fetchedSource !== source || fetchedQuery.trim() !== query.trim());

  // Derived chart data
  const sourceChartData = useMemo(() => {
    if (!sourceMetrics || sourceMetrics.length === 0) return null;
    return sourceMetrics.map((m) => ({
      name: m.label.replace(" (GDELT)", "").replace("Health Alerts ", "").split(" (")[0],
      count: m.count,
      scanned: m.scanned,
      latency: m.latencyMs,
      ok: m.ok,
      source: m.source,
    }));
  }, [sourceMetrics]);

  const entityChartData = useMemo(() => {
    if (entities.length === 0) return null;
    return KIND_ORDER
      .filter((k) => grouped.has(k))
      .map((k) => ({ kind: k, count: grouped.get(k)!.length, fill: KIND_COLORS[k] ?? "#94a3b8" }));
  }, [entities, grouped]);

  const confidenceData = useMemo(() => {
    if (entities.length === 0) return null;
    const withConf = entities.filter((e) => typeof e.confidence === "number");
    if (withConf.length === 0) return null;
    const buckets: Record<string, number> = { "0.0–0.3": 0, "0.3–0.5": 0, "0.5–0.7": 0, "0.7–0.9": 0, "0.9–1.0": 0 };
    const fills: Record<string, string> = { "0.0–0.3": "#f87171", "0.3–0.5": "#fb923c", "0.5–0.7": "#fbbf24", "0.7–0.9": "#34d399", "0.9–1.0": "#22d3ee" };
    for (const e of withConf) {
      const c = e.confidence ?? 0;
      if (c < 0.3) buckets["0.0–0.3"] = (buckets["0.0–0.3"] ?? 0) + 1;
      else if (c < 0.5) buckets["0.3–0.5"] = (buckets["0.3–0.5"] ?? 0) + 1;
      else if (c < 0.7) buckets["0.5–0.7"] = (buckets["0.5–0.7"] ?? 0) + 1;
      else if (c < 0.9) buckets["0.7–0.9"] = (buckets["0.7–0.9"] ?? 0) + 1;
      else buckets["0.9–1.0"] = (buckets["0.9–1.0"] ?? 0) + 1;
    }
    return Object.entries(buckets).map(([label, count]) => ({ label, count, fill: fills[label] ?? "#94a3b8" }));
  }, [entities]);

  return (
    <Panel className="border-white/10">
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle>Signal Intake Sandbox</PanelTitle>
          <div className="truncate text-xs text-muted">
            Public adapter pipeline · {SOURCES[source].hint}{fetchedQuery ? ` · fetched "${fetchedQuery}"` : ""}{fetchedAt ? ` · updated ${formatRelative(fetchedAt)}` : ""}
          </div>
        </div>
        <StatusPill tone={error ? "rose" : queryDirty ? "amber" : items.length > 0 ? "green" : "amber"}>
          {error ? "fetch error" : loading ? "loading" : queryDirty ? "query changed" : `${items.length} relevant items`}
        </StatusPill>
      </PanelHeader>
      <PanelBody className="grid gap-3">
        {/* Source tabs — 6 sources in 2 rows of 3 */}
        <div className="grid gap-2 lg:grid-cols-[minmax(340px,420px)_minmax(260px,1fr)] xl:grid-cols-[minmax(340px,400px)_minmax(300px,1fr)_auto] xl:items-start">
          <div className="grid gap-1 rounded-md border border-white/10 bg-black/28 p-1">
            <div className="grid grid-cols-3 gap-1">
              {SOURCE_TABS.slice(0, 3).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleSourceChange(key)}
                  className={cn(
                    "h-7 min-w-0 rounded px-2 text-xs font-medium transition",
                    source === key
                      ? "bg-white/16 text-foreground"
                      : "text-muted hover:bg-white/5 hover:text-foreground",
                  )}
                >
                  <span className="block truncate">{SOURCES[key].label}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-1">
              {SOURCE_TABS.slice(3).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleSourceChange(key)}
                  className={cn(
                    "h-7 min-w-0 rounded px-2 text-xs font-medium transition",
                    source === key
                      ? "bg-white/16 text-foreground"
                      : "text-muted hover:bg-white/5 hover:text-foreground",
                  )}
                >
                  <span className="block truncate">{SOURCES[key].label}</span>
                </button>
              ))}
            </div>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void refresh(source, query);
              }
            }}
            placeholder="symptom, product, district, source note, or misinformation pattern"
          />
          <div className="flex flex-wrap gap-2 lg:col-span-2 xl:col-span-1 xl:justify-end">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={cn(
                "inline-flex h-9 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition",
                autoRefresh
                  ? "border-white/25 bg-white/8 text-foreground"
                  : "border-border bg-background/60 text-muted hover:text-foreground",
              )}
              title="Auto-refresh every 60s"
            >
              <span className={cn("inline-block size-1.5 rounded-full", autoRefresh ? "animate-pulse bg-foreground" : "bg-muted")} />
              {autoRefresh ? "live" : "paused"}
            </button>
            <Button onClick={() => void refresh(source, query)} disabled={loading} variant="outline">
              {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
              {queryDirty ? "Fetch query" : "Fetch"}
            </Button>
            <Button onClick={handleExtract} disabled={extracting || items.length === 0 || queryDirty}>
              {extracting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
              Extract entities
            </Button>
          </div>
        </div>

        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-white/20 bg-white/[0.06] px-3 py-2 text-xs text-foreground/80">
            <AlertTriangle size={14} className="mt-0.5" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        {feedNotice || queryDirty ? (
          <div className="flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.035] px-3 py-2 text-xs leading-5 text-muted">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-foreground/70" aria-hidden="true" />
            <span>{queryDirty ? `Showing results fetched for "${fetchedQuery}". Fetch again to collect "${query}".` : feedNotice}</span>
          </div>
        ) : null}

        {/* Source breakdown bar chart — shown when "All Sources" returns per-source metrics */}
        {sourceChartData && sourceChartData.length > 0 ? (
          <div className="rounded-md border border-white/10 bg-black/24 p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-normal text-muted">
              <span className="flex items-center gap-1.5">
                <Zap size={11} aria-hidden="true" />
                Source Breakdown · {items.length} total signals
              </span>
              <span>{sourceMetrics?.filter((m) => m.ok).length ?? 0}/{sourceMetrics?.length ?? 0} sources live</span>
            </div>
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={sourceChartData} margin={{ top: 0, right: 4, bottom: 0, left: -28 }} barSize={22}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "#0a0a0f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "6px", fontSize: "11px", color: "#e2e8f0" }}
                  labelStyle={{ color: "#94a3b8" }}
                  formatter={(value: unknown, _name: unknown, props: { payload?: { latency?: number; scanned?: number; ok?: boolean } }) => [
                    `${String(value)} items (scanned: ${props.payload?.scanned ?? 0}, ${props.payload?.latency ?? 0}ms)`,
                    props.payload?.ok ? "✓ live" : "✗ failed",
                  ] as [string, string]}
                />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {sourceChartData.map((entry) => (
                    <Cell
                      key={entry.source}
                      fill={(entry.ok ? (CHART_COLORS[entry.source] ?? CHART_COLORS.default) : "#374151") as string}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {sourceMetrics?.map((m) => (
                <span
                  key={m.source}
                  className={cn(
                    "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
                    m.ok ? "border-white/10 bg-white/5 text-foreground/70" : "border-rose-500/30 bg-rose-500/10 text-rose-300",
                  )}
                >
                  <span className={cn("inline-block size-1.5 rounded-full", m.ok ? "bg-emerald-400" : "bg-rose-400")} />
                  {m.label.split(" (")[0]} · {m.latencyMs}ms · {m.count}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Signal history area chart */}
        {signalTimeline.length >= 2 ? (
          <div className="rounded-md border border-white/10 bg-black/20 px-3 pt-2 pb-1">
            <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-normal text-muted">
              <span>Signal History · last {signalTimeline.length} fetches</span>
              <span className="text-muted/60">peak: {Math.max(...signalTimeline.map((p) => p.count))}</span>
            </div>
            <ResponsiveContainer width="100%" height={56}>
              <AreaChart data={signalTimeline} margin={{ top: 2, right: 0, bottom: 0, left: -36 }}>
                <defs>
                  <linearGradient id="sigGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis hide />
                <Tooltip
                  contentStyle={{ background: "#0a0a0f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "6px", fontSize: "10px", color: "#e2e8f0" }}
                  formatter={(value: unknown) => [`${String(value)} signals`, "count"] as [string, string]}
                />
                <Area type="monotone" dataKey="count" stroke="#22d3ee" strokeWidth={1.5} fill="url(#sigGrad)" dot={false} activeDot={{ r: 3, fill: "#22d3ee" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}

        <div className="grid gap-3 lg:items-start lg:grid-cols-[1.4fr_1fr]">
          <div className="grid gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-normal text-muted">
              Items {items.length > 0 ? `· ${items.length}` : ""}{fetchedQuery ? ` · ${fetchedQuery}` : ""}
            </div>
            <div className="max-h-[460px] overflow-auto rounded-md border border-white/10 bg-black/24">
              {items.length === 0 ? (
                <div className="grid min-h-32 place-items-center p-6 text-center text-sm text-muted">
                  {loading ? "Fetching public-health intake..." : feedNotice ?? "No high-relevance items returned for this source."}
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {items.map((item) => (
                    <li key={item.id} className="grid gap-1.5 p-3 transition hover:bg-white/[0.02]">
                      <div className="flex items-start justify-between gap-2">
                        <a
                          href={item.url ?? undefined}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="line-clamp-2 text-sm font-medium text-foreground hover:text-foreground"
                        >
                          {item.title}
                        </a>
                        {item.url ? (
                          <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                        <span className="rounded border border-white/[0.10] bg-white/[0.07] px-1.5 py-0.5 uppercase tracking-normal text-foreground/65">{formatSourceLabel(item.source)}</span>
                        {item.author ? <span>{item.author}</span> : null}
                        {item.publishedAt ? <span>{formatRelative(item.publishedAt)}</span> : null}
                        {item.relevance ? <span>{item.relevance.matchedTerms.length}/{item.relevance.requiredTerms.length} terms · score {item.relevance.score}</span> : null}
                        {item.score !== null ? <span>↑ {item.score}</span> : null}
                        {item.comments !== null ? <span>{item.comments} cmt</span> : null}
                      </div>
                      {onPromote ? (
                        <div>
                          <button
                            type="button"
                            onClick={() =>
                              onPromote({
                                text: `${item.title}${item.url ? `\n${item.url}` : ""}`,
                                source: item.source,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-muted transition hover:border-accent-cyan/50 hover:text-foreground"
                          >
                            <Target size={11} aria-hidden="true" />
                            Promote to lead
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-normal text-muted">
              <span>Entity Intel Board {entities.length > 0 ? `· ${entities.length}` : ""}</span>
              {extractedAt ? <span className="text-muted/70">{formatRelative(extractedAt)}</span> : null}
            </div>
            {extractionRuntime ? (
              <div className={cn(
                "rounded border px-2 py-1 text-[11px]",
                !extractionRuntime.fallback
                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                  : entities.length > 0
                    ? "border-sky-400/30 bg-sky-500/10 text-sky-200"
                    : "border-amber-400/30 bg-amber-500/10 text-amber-100",
              )}>
                {extractionRuntime.fallback
                  ? entities.length > 0
                    ? `Edge-NLP active · ${entities.length} entities extracted`
                    : `Extraction engine unavailable · ${extractionRuntime.fallbackReason ?? "check LLM endpoint"}`
                  : `Neural primary · ${entities.length} entities · ${extractionRuntime.model}`}
              </div>
            ) : null}
            {/* Entity type distribution — pie + radial breakdown */}
            {entityChartData && entityChartData.length > 0 ? (
              <div className="rounded border border-white/10 bg-black/20 px-2 pt-2 pb-1">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-normal text-muted">Entity Distribution · {entities.length} total</div>
                <div className="grid grid-cols-[auto_1fr] gap-1 items-center">
                  <ResponsiveContainer width={80} height={80}>
                    <PieChart>
                      <Pie
                        data={entityChartData}
                        dataKey="count"
                        nameKey="kind"
                        cx="50%"
                        cy="50%"
                        innerRadius={22}
                        outerRadius={36}
                        strokeWidth={0}
                        paddingAngle={2}
                      >
                        {entityChartData.map((entry) => (
                          <Cell key={entry.kind} fill={entry.fill as string} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ background: "#0a0a0f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "6px", fontSize: "10px", color: "#e2e8f0" }}
                        formatter={(value: unknown, name: unknown) => [`${String(value)}`, String(name)] as [string, string]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                    {entityChartData.slice(0, 8).map((entry) => (
                      <div key={entry.kind} className="flex items-center gap-1 text-[9px] text-muted/80">
                        <span className="inline-block size-1.5 shrink-0 rounded-sm" style={{ background: entry.fill }} />
                        <span className="truncate">{entry.kind}</span>
                        <span className="ml-auto font-mono text-foreground/60">{entry.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
                {/* Radial bar sub-chart for counts */}
                <ResponsiveContainer width="100%" height={54}>
                  <RadialBarChart
                    cx="50%"
                    cy="100%"
                    innerRadius="30%"
                    outerRadius="90%"
                    startAngle={180}
                    endAngle={0}
                    data={entityChartData.slice(0, 6).map((d, i) => ({ ...d, fill: d.fill, index: i }))}
                    barSize={5}
                  >
                    <RadialBar dataKey="count" cornerRadius={3} background={{ fill: "rgba(255,255,255,0.03)" }}>
                      {entityChartData.slice(0, 6).map((entry) => (
                        <Cell key={entry.kind} fill={entry.fill as string} />
                      ))}
                    </RadialBar>
                    <Tooltip
                      contentStyle={{ background: "#0a0a0f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "6px", fontSize: "10px", color: "#e2e8f0" }}
                      formatter={(value: unknown, _n: unknown, props: { payload?: { kind?: string } }) => [`${String(value)} entities`, props.payload?.kind ?? ""] as [string, string]}
                    />
                  </RadialBarChart>
                </ResponsiveContainer>
              </div>
            ) : null}
            {/* Confidence distribution histogram */}
            {confidenceData ? (
              <div className="rounded border border-white/10 bg-black/20 px-2 pt-2 pb-1">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-normal text-muted">Confidence Distribution</div>
                <ResponsiveContainer width="100%" height={52}>
                  <BarChart data={confidenceData} margin={{ top: 0, right: 4, bottom: 0, left: -28 }} barSize={18}>
                    <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 8 }} axisLine={false} tickLine={false} />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={{ background: "#0a0a0f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "6px", fontSize: "10px", color: "#e2e8f0" }}
                      formatter={(value: unknown, _n: unknown, props: { payload?: { label?: string } }) => [`${String(value)} entities`, props.payload?.label ?? ""] as [string, string]}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                      {confidenceData.map((entry) => (
                        <Cell key={entry.label} fill={entry.fill as string} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : null}
            <div className="max-h-[520px] overflow-auto rounded-md border border-white/10 bg-black/24 p-2">
              {entities.length === 0 ? (
                <div className="grid min-h-32 place-items-center p-4 text-center text-xs text-muted">
                  {extracting ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                      Extracting entities from {items.length} signals…
                    </span>
                  ) : (
                    "Entities are extracted automatically after each fetch. Click \"Extract entities\" to refresh manually."
                  )}
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div className="rounded border border-border bg-panel/60 p-2">
                      <div className="text-muted">Types</div>
                      <div className="mt-1 font-mono text-sm text-foreground">{KIND_ORDER.filter((kind) => grouped.has(kind)).length}</div>
                    </div>
                    <div className="rounded border border-border bg-panel/60 p-2">
                      <div className="text-muted">Entities</div>
                      <div className="mt-1 font-mono text-sm text-foreground">{entities.length}</div>
                    </div>
                    <div className="rounded border border-border bg-panel/60 p-2">
                      <div className="text-muted">Selected</div>
                      <div className="mt-1 truncate font-mono text-sm text-foreground">{selectedEntity?.kind ?? "none"}</div>
                    </div>
                  </div>

                  {KIND_ORDER.filter((kind) => grouped.has(kind)).map((kind) => (
                    <div key={kind} className="grid gap-1.5">
                      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-normal text-muted">
                        <span>{kind}</span>
                        <span>{grouped.get(kind)!.length} extracted</span>
                      </div>
                      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        {grouped.get(kind)!.slice(0, 24).map((entity) => (
                          <button
                            key={`${entity.kind}:${entity.value}`}
                            type="button"
                            onClick={() => void lookupEntity(entity)}
                            className={cn(
                              "grid min-h-12 gap-1 rounded border px-2 py-1.5 text-left text-[11px] transition hover:opacity-100",
                              toneClass(ENTITY_TONE[kind]),
                              selectedEntity?.kind === entity.kind && selectedEntity.value === entity.value ? "ring-1 ring-white/30" : "opacity-90",
                            )}
                            title="Build multi-source OSINT dossier"
                          >
                            <span className="line-clamp-2 break-words font-medium leading-4">{entity.value}</span>
                            <span className="flex items-center justify-between gap-2 font-mono text-[10px] opacity-70">
                              <span>{entity.kind}</span>
                              <span>×{entity.count}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {selectedEntity ? (
          <div className="rounded-md border border-white/[0.10] bg-black/28 p-3 text-xs shadow-[0_0_24px_rgba(255,255,255,0.04)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 font-semibold text-foreground">
                      <Fingerprint size={14} className="shrink-0 text-foreground/60" aria-hidden="true" />
                      <span className="truncate">{dossier?.title ?? selectedEntity.value}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-normal text-muted">
                      <span className={cn("rounded border px-1.5 py-0.5", toneClass(ENTITY_TONE[selectedEntity.kind]))}>{selectedEntity.kind}</span>
                      {dossier ? <span>{dossier.sourceCount} source lanes</span> : null}
                      {dossier ? <span>{dossier.confidence}% confidence</span> : null}
                    </div>
                  </div>
                  {dossierLoading ? <Loader2 size={15} className="shrink-0 animate-spin text-foreground/60" aria-hidden="true" /> : null}
                </div>

                <div className="mt-3 leading-5 text-muted">
                  {dossierLoading && dossier === null ? "Building multi-source entity dossier…" : dossier?.summary ?? "Preparing local dossier fallback."}
                </div>

                {dossier ? (
                  <div className="mt-3 grid gap-3">
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <DossierMetric icon={<ShieldCheck size={13} aria-hidden="true" />} label="confidence" value={`${dossier.confidence}%`} />
                      <DossierMetric icon={<Database size={13} aria-hidden="true" />} label="sources" value={String(dossier.sourceCount)} />
                      <DossierMetric icon={<Network size={13} aria-hidden="true" />} label="edges" value={String(dossier.graph.relationships.length)} />
                    </div>

                    <div className="grid gap-1.5">
                      <div className="text-[10px] font-semibold uppercase tracking-normal text-muted">Source Coverage</div>
                      <div className="grid gap-1.5">
                        {dossier.sources.slice(0, 6).map((sourceLane) => (
                          <div key={sourceLane.id} className="rounded border border-border bg-background/35 p-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 font-medium text-foreground">
                                  <Globe2 size={12} className="shrink-0 text-foreground/60" aria-hidden="true" />
                                  <span className="truncate">{sourceLane.name}</span>
                                </div>
                                <div className="mt-1 line-clamp-2 leading-4 text-muted">{sourceLane.description}</div>
                              </div>
                              <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase", sourceStatusClass(sourceLane.status))}>
                                {sourceLane.status}
                              </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted/80">
                              <span className="truncate">{sourceLane.category} · {Math.round(sourceLane.confidence * 100)}%</span>
                              {sourceLane.url ? (
                                <a href={sourceLane.url} target={sourceLane.url.startsWith("/") ? undefined : "_blank"} rel="noreferrer noopener" className="inline-flex shrink-0 items-center gap-1 text-foreground/70 hover:underline">
                                  open <ExternalLink size={10} aria-hidden="true" />
                                </a>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {dossier.mentions.length > 0 ? (
                      <div className="grid gap-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-normal text-muted">Latest Mentions / Advisories</div>
                        <div className="grid gap-1.5">
                          {dossier.mentions.slice(0, 4).map((mention, index) => (
                            <a
                              key={`${mention.source}:${mention.title}:${index}`}
                              href={mention.url ?? undefined}
                              target={mention.url ? "_blank" : undefined}
                              rel="noreferrer noopener"
                              className={cn("rounded border border-border bg-background/35 p-2 leading-4 transition", mention.url ? "hover:border-white/25 hover:text-foreground" : "cursor-default")}
                            >
                              <div className="line-clamp-2 font-medium text-foreground">{mention.title}</div>
                              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-muted">
                                <span>{mention.source}</span>
                                {mention.publishedAt ? <span>{formatRelative(mention.publishedAt)}</span> : null}
                                <span>{mention.detail}</span>
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {onPromote ? (
                      <button
                        type="button"
                        onClick={() => onPromote({ text: `${dossier.title}\n${dossier.summary}`, source: "entity dossier" })}
                        className="inline-flex w-fit items-center gap-1 rounded border border-white/20 px-2 py-1 text-[11px] text-foreground/70 transition hover:bg-white/[0.06]"
                      >
                        <Target size={11} aria-hidden="true" />
                        Promote dossier
                      </button>
                    ) : null}
                  </div>
                ) : null}
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function groupEntities(entities: ExtractedEntity[]): Map<EntityKind, ExtractedEntity[]> {
  const out = new Map<EntityKind, ExtractedEntity[]>();
  for (const entity of entities) {
    const list = out.get(entity.kind);
    if (list) {
      list.push(entity);
    } else {
      out.set(entity.kind, [entity]);
    }
  }
  return out;
}

function formatSourceLabel(source: string): string {
  if (source === "hackernews") return "open web";
  if (source === "reddit") return "community";
  if (source === "gdelt") return "news";
  if (source === "pubmed") return "pubmed";
  if (source === "who") return "who/cdc";
  if (source === "all") return "multi";
  return source;
}

function DossierMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-background/35 p-2">
      <div className="flex items-center gap-1 text-muted">
        {icon}
        <span className="truncate uppercase tracking-normal">{label}</span>
      </div>
      <div className="mt-1 font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}

function buildClientDossierFallback(entity: ExtractedEntity): EntityDossier {
  return {
    found: true,
    term: entity.value,
    normalized: entity.value.replace(/[’']/g, "").trim(),
    kind: entity.kind,
    title: entity.value,
    summary: `${entity.value} is retained as a local ${entity.kind.toLowerCase()} intelligence object. The server dossier endpoint was unavailable, so this fallback preserves the pivot for analyst review instead of dropping into a dead-end lookup state.`,
    confidence: 44,
    sourceCount: 1,
    generatedAt: new Date().toISOString(),
    sources: [{
      id: "local-client-fallback",
      name: "Local analyst cache",
      category: "prototype fallback",
      status: "modeled",
      confidence: 0.44,
      title: "Client-side dossier fallback",
      description: "Generated in the browser when the multi-source entity API could not be reached.",
      url: null,
    }],
    mentions: [],
    graph: { entities: [], relationships: [] },
  };
}

function sourceStatusClass(status: SourceStatus): string {
  if (status === "hit") {
    return "border-accent-green/35 bg-accent-green/10 text-accent-green";
  }
  if (status === "modeled") {
    return "border-accent-cyan/35 bg-accent-cyan/10 text-accent-cyan";
  }
  if (status === "scoped") {
    return "border-accent-blue/35 bg-accent-blue/10 text-accent-blue";
  }
  if (status === "error") {
    return "border-accent-rose/35 bg-accent-rose/10 text-accent-rose";
  }
  return "border-border bg-white/5 text-muted";
}

function toneClass(tone: "cyan" | "blue" | "amber" | "green" | "rose"): string {
  if (tone === "blue") {
    return "border-accent-blue/35 bg-accent-blue/10 text-accent-blue";
  }
  if (tone === "amber") {
    return "border-accent-amber/35 bg-accent-amber/10 text-accent-amber";
  }
  if (tone === "green") {
    return "border-accent-green/35 bg-accent-green/10 text-accent-green";
  }
  if (tone === "rose") {
    return "border-accent-rose/35 bg-accent-rose/10 text-accent-rose";
  }
  return "border-accent-cyan/35 bg-accent-cyan/10 text-accent-cyan";
}

function formatRelative(timestamp: string): string {
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) {
    return "";
  }
  const ageMs = Date.now() - ts;
  if (ageMs < 5_000) {
    return "just now";
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) {
    return `${Math.floor(ageMs / 1000)}s ago`;
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
