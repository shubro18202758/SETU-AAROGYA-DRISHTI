"use client";

import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Funnel,
  FunnelChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart2, GitBranch, Layers, Shrink, TrendingUp } from "lucide-react";

import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";

// ── Styling ───────────────────────────────────────────────────────────────────
const TOOLTIP_STYLE = {
  background: "#0a0a0f",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "6px",
  fontSize: "10px",
  color: "#e2e8f0",
  padding: "6px 10px",
} as const;

const KIND_COLORS: Record<string, string> = {
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

const SOURCE_COLORS: Record<string, string> = {
  hackernews: "#fb923c",
  reddit: "#f87171",
  gdelt: "#60a5fa",
  pubmed: "#34d399",
  who: "#a78bfa",
  all: "#22d3ee",
};

const ALL_KINDS = [
  "ORG", "PERSON", "GEO", "EVENT", "CVE",
  "IP", "URL", "EMAIL", "HASH", "MONEY", "DATE",
];

const FUNNEL_FILLS = ["#22d3ee", "#60a5fa", "#34d399", "#fbbf24"] as const;

// ── Types ─────────────────────────────────────────────────────────────────────
interface TreemapEntry {
  name: string;
  size: number;
  fill: string;
}

interface TimelinePoint {
  t: string;
  [kind: string]: number | string;
}

interface ConfBucket {
  range: string;
  count: number;
  fill: string;
}

interface FunnelEntry {
  name: string;
  value: number;
  fill: string;
}

interface EntitiesDetail {
  entities: Array<{ kind: string; value: string; count: number; confidence?: number }>;
}

interface FeedPulseDetail {
  source: string;
  items: number;
  entities?: Array<{ kind: string; value: string; count: number; confidence?: number }>;
  ok: boolean;
}

interface FunnelState {
  crawled: number;
  withEntities: number;
  entities: number;
  highConf: number;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function IntelligenceAnalytics() {
  const [treemapData, setTreemapData] = useState<TreemapEntry[]>([]);
  const [confBuckets, setConfBuckets] = useState<ConfBucket[]>(
    Array.from({ length: 10 }, (_, i) => ({
      range: `${i * 10}%`,
      count: 0,
      fill: i < 3 ? "#ef4444" : i < 6 ? "#f59e0b" : i < 8 ? "#22d3ee" : "#34d399",
    })),
  );
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [funnelData, setFunnelData] = useState<FunnelEntry[]>([
    { name: "Crawled", value: 0, fill: FUNNEL_FILLS[0] },
    { name: "w/ Entities", value: 0, fill: FUNNEL_FILLS[1] },
    { name: "Extracted", value: 0, fill: FUNNEL_FILLS[2] },
    { name: "High Conf", value: 0, fill: FUNNEL_FILLS[3] },
  ]);
  const [correlationSources, setCorrelationSources] = useState<string[]>([]);
  const [correlationCells, setCorrelationCells] = useState<
    Array<{ source: string; kind: string; count: number; intensity: number }>
  >([]);

  const kindCountRef = useRef<Map<string, number>>(new Map());
  const correlationRef = useRef<Map<string, Map<string, number>>>(new Map());
  const timelineKindsRef = useRef<Set<string>>(new Set());
  const funnelRef = useRef<FunnelState>({ crawled: 0, withEntities: 0, entities: 0, highConf: 0 });

  useEffect(() => {
    function handleEntities(ev: Event) {
      const { entities } = (ev as CustomEvent<EntitiesDetail>).detail;
      if (!entities?.length) return;

      for (const ent of entities) {
        kindCountRef.current.set(ent.kind, (kindCountRef.current.get(ent.kind) ?? 0) + ent.count);

        if (typeof ent.confidence === "number") {
          const bucket = Math.min(9, Math.floor(ent.confidence * 10));
          setConfBuckets((prev) => {
            const next = [...prev];
            const b = next[bucket];
            if (b) next[bucket] = { ...b, count: b.count + 1 };
            return next;
          });
          if (ent.confidence >= 0.7) funnelRef.current.highConf++;
        }
        funnelRef.current.entities += ent.count;
      }

      const entries: TreemapEntry[] = [];
      kindCountRef.current.forEach((size, name) => {
        entries.push({ name, size, fill: KIND_COLORS[name] ?? "#94a3b8" });
      });
      setTreemapData(entries.sort((a, b) => b.size - a.size));

      const f = funnelRef.current;
      setFunnelData([
        { name: "Crawled", value: f.crawled, fill: FUNNEL_FILLS[0] },
        { name: "w/ Entities", value: f.withEntities, fill: FUNNEL_FILLS[1] },
        { name: "Extracted", value: f.entities, fill: FUNNEL_FILLS[2] },
        { name: "High Conf", value: f.highConf, fill: FUNNEL_FILLS[3] },
      ]);
    }

    function handleFeedPulse(ev: Event) {
      const detail = (ev as CustomEvent<FeedPulseDetail>).detail;
      if (!detail.ok) return;

      funnelRef.current.crawled += detail.items;
      if (detail.entities?.length) funnelRef.current.withEntities += detail.items;

      const src = detail.source;
      if (!detail.entities?.length) return;

      if (!correlationRef.current.has(src)) correlationRef.current.set(src, new Map());
      const srcMap = correlationRef.current.get(src)!;
      for (const ent of detail.entities) {
        srcMap.set(ent.kind, (srcMap.get(ent.kind) ?? 0) + ent.count);
      }

      // Rebuild correlation cells
      const sources = [...correlationRef.current.keys()];
      const cells: Array<{ source: string; kind: string; count: number; intensity: number }> = [];
      const maxBySrc: Record<string, number> = {};
      for (const s of sources) {
        let m = 0;
        correlationRef.current.get(s)!.forEach((v) => { if (v > m) m = v; });
        maxBySrc[s] = m;
      }
      for (const s of sources) {
        for (const kind of ALL_KINDS) {
          const count = correlationRef.current.get(s)?.get(kind) ?? 0;
          const max = maxBySrc[s] ?? 1;
          cells.push({ source: s, kind, count, intensity: max > 0 ? count / max : 0 });
        }
      }
      setCorrelationSources(sources);
      setCorrelationCells(cells);

      // Update timeline
      const t = new Date().toLocaleTimeString("en-GB", { hour12: false });
      const point: TimelinePoint = { t };
      for (const ent of detail.entities) {
        point[ent.kind] = (typeof point[ent.kind] === "number" ? (point[ent.kind] as number) : 0) + ent.count;
        timelineKindsRef.current.add(ent.kind);
      }
      setTimeline((prev) => [...prev.slice(-19), point]);
    }

    window.addEventListener("osint:entities-extracted", handleEntities);
    window.addEventListener("osint:feed-pulse", handleFeedPulse);
    return () => {
      window.removeEventListener("osint:entities-extracted", handleEntities);
      window.removeEventListener("osint:feed-pulse", handleFeedPulse);
    };
  }, []);

  const timelineKinds = [...timelineKindsRef.current];
  const hasFunnelData = funnelData.some((d) => d.value > 0);

  return (
    <div className="grid gap-3">
      {/* ── Row 1: Treemap · Confidence · Timeline ─────────────────── */}
      <div className="grid gap-3 xl:grid-cols-3">

        {/* Entity Kind Treemap */}
        <Panel className="border-white/10 bg-black/40">
          <PanelHeader>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-foreground/70">
              <Layers size={11} className="text-cyan-400" aria-hidden />
              Entity Treemap
            </div>
            <span className="text-[9px] uppercase tracking-wider text-muted/40">cumulative frequency</span>
          </PanelHeader>
          <PanelBody>
            {treemapData.length === 0 ? (
              <EmptySlate height={160} />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={140}>
                  <Treemap data={treemapData} dataKey="size" aspectRatio={4 / 3}>
                    {treemapData.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill as string} />
                    ))}
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(v: unknown) => [`${String(v)} entities`, "count"] as [string, string]}
                    />
                  </Treemap>
                </ResponsiveContainer>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {treemapData.map((entry) => (
                    <span key={entry.name} className="flex items-center gap-1 text-[9px] font-mono text-muted/70">
                      <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: entry.fill }} />
                      {entry.name}
                    </span>
                  ))}
                </div>
              </>
            )}
          </PanelBody>
        </Panel>

        {/* Confidence Spectrum */}
        <Panel className="border-white/10 bg-black/40">
          <PanelHeader>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-foreground/70">
              <BarChart2 size={11} className="text-cyan-400" aria-hidden />
              Confidence Spectrum
            </div>
            <span className="text-[9px] uppercase tracking-wider text-muted/40">extraction quality</span>
          </PanelHeader>
          <PanelBody>
            <ResponsiveContainer width="100%" height={185}>
              <BarChart data={confBuckets} margin={{ top: 4, right: 4, bottom: 28, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="range"
                  tick={{ fill: "#4b5563", fontSize: 8 }}
                  axisLine={false}
                  tickLine={false}
                  angle={-45}
                  textAnchor="end"
                  interval={0}
                />
                <YAxis tick={{ fill: "#4b5563", fontSize: 8 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: unknown) => [String(v), "entities"] as [string, string]}
                />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {confBuckets.map((b) => (
                    <Cell key={b.range} fill={b.fill as string} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </PanelBody>
        </Panel>

        {/* Entity Extraction Timeline */}
        <Panel className="border-white/10 bg-black/40">
          <PanelHeader>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-foreground/70">
              <TrendingUp size={11} className="text-cyan-400" aria-hidden />
              Extraction Timeline
            </div>
            <span className="text-[9px] uppercase tracking-wider text-muted/40">per-pulse · by kind</span>
          </PanelHeader>
          <PanelBody>
            {timeline.length === 0 ? (
              <EmptySlate height={185} message="Awaiting feed pulses…" />
            ) : (
              <ResponsiveContainer width="100%" height={185}>
                <AreaChart data={timeline} margin={{ top: 4, right: 4, bottom: 4, left: -18 }}>
                  <defs>
                    {timelineKinds.map((k) => (
                      <linearGradient key={k} id={`ia-tl-${k}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={KIND_COLORS[k] ?? "#94a3b8"} stopOpacity={0.45} />
                        <stop offset="95%" stopColor={KIND_COLORS[k] ?? "#94a3b8"} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis
                    dataKey="t"
                    tick={{ fill: "#4b5563", fontSize: 7 }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fill: "#4b5563", fontSize: 8 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  {timelineKinds.map((k) => (
                    <Area
                      key={k}
                      type="monotone"
                      dataKey={k}
                      stackId="1"
                      stroke={KIND_COLORS[k] ?? "#94a3b8"}
                      fill={`url(#ia-tl-${k})`}
                      strokeWidth={1.2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </PanelBody>
        </Panel>
      </div>

      {/* ── Row 2: Correlation Matrix · Pipeline Funnel ─────────────── */}
      <div className="grid gap-3 xl:grid-cols-[1.5fr_0.5fr]">

        {/* Source × Entity Kind Correlation */}
        <Panel className="border-white/10 bg-black/40">
          <PanelHeader>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-foreground/70">
              <GitBranch size={11} className="text-cyan-400" aria-hidden />
              Source × Entity Kind Correlation
            </div>
            <span className="text-[9px] uppercase tracking-wider text-muted/40">extraction heatmap</span>
          </PanelHeader>
          <PanelBody>
            {correlationSources.length === 0 ? (
              <EmptySlate height={160} message="Correlation data populates after first query" />
            ) : (
              <CorrelationMatrix sources={correlationSources} cells={correlationCells} />
            )}
          </PanelBody>
        </Panel>

        {/* Signal Pipeline Funnel */}
        <Panel className="border-white/10 bg-black/40">
          <PanelHeader>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-foreground/70">
              <Shrink size={11} className="text-cyan-400" aria-hidden />
              Pipeline Funnel
            </div>
            <span className="text-[9px] uppercase tracking-wider text-muted/40">crawl → high-conf</span>
          </PanelHeader>
          <PanelBody>
            {!hasFunnelData ? (
              <EmptySlate height={160} />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <FunnelChart>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v: unknown) => [String(v), "items"] as [string, string]}
                  />
                  <Funnel dataKey="value" data={funnelData} isAnimationActive={false}>
                    {funnelData.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill as string} />
                    ))}
                    <LabelList
                      position="right"
                      fill="#6b7280"
                      stroke="none"
                      dataKey="name"
                      fontSize={9}
                    />
                  </Funnel>
                </FunnelChart>
              </ResponsiveContainer>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function EmptySlate({
  height,
  message = "Run a query to populate",
}: {
  height: number;
  message?: string;
}) {
  return (
    <div
      className="flex items-center justify-center text-[11px] text-muted/40"
      style={{ height }}
    >
      {message}
    </div>
  );
}

function CorrelationMatrix({
  sources,
  cells,
}: {
  sources: string[];
  cells: Array<{ source: string; kind: string; count: number; intensity: number }>;
}) {
  const cellMap = new Map(cells.map((c) => [`${c.source}:${c.kind}`, c]));
  const activeKinds = ALL_KINDS.filter((k) => cells.some((c) => c.kind === k && c.count > 0));

  return (
    <div className="overflow-x-auto">
      <table className="min-w-[360px] border-collapse text-[9px]">
        <thead>
          <tr>
            <th className="w-24 px-2 py-1 text-left font-normal text-muted/50">Source</th>
            {activeKinds.map((kind) => (
              <th
                key={kind}
                className="px-1 py-1 text-center font-semibold"
                style={{ color: KIND_COLORS[kind] ?? "#94a3b8" }}
              >
                {kind}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((src) => (
            <tr key={src} className="border-t border-white/[0.04]">
              <td className="px-2 py-1 font-mono" style={{ color: SOURCE_COLORS[src] ?? "#94a3b8" }}>
                {src}
              </td>
              {activeKinds.map((kind) => {
                const cell = cellMap.get(`${src}:${kind}`);
                const intensity = cell?.intensity ?? 0;
                const count = cell?.count ?? 0;
                return (
                  <td key={kind} className="px-1 py-1 text-center" title={`${src} × ${kind}: ${count}`}>
                    <div
                      className="mx-auto rounded-sm transition-colors"
                      style={{
                        width: 22,
                        height: 16,
                        background:
                          intensity > 0
                            ? `rgba(34,211,238,${(0.08 + intensity * 0.75).toFixed(2)})`
                            : "rgba(255,255,255,0.03)",
                        border:
                          intensity > 0.5
                            ? "1px solid rgba(34,211,238,0.35)"
                            : "1px solid rgba(255,255,255,0.05)",
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
