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
  Legend,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Activity, BarChart2, GitBranch, Layers, Shrink, TrendingUp, Zap } from "lucide-react";

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

// ── Seed data (shown on first paint, before any queries fire) ─────────────────
const SEED_TREEMAP = [
  { name: "ORG",    size: 28, fill: "#22d3ee" },
  { name: "GEO",    size: 21, fill: "#34d399" },
  { name: "PERSON", size: 17, fill: "#60a5fa" },
  { name: "URL",    size: 14, fill: "#f59e0b" },
  { name: "CVE",    size: 11, fill: "#f87171" },
  { name: "IP",     size:  9, fill: "#fb7185" },
  { name: "EVENT",  size:  8, fill: "#fbbf24" },
  { name: "DATE",   size:  6, fill: "#93c5fd" },
  { name: "EMAIL",  size:  5, fill: "#fcd34d" },
  { name: "HASH",   size:  4, fill: "#e11d48" },
  { name: "MONEY",  size:  3, fill: "#86efac" },
];
const SEED_CONF_BUCKETS = [
  { range: "0%",  count:  1, fill: "#ef4444" },
  { range: "10%", count:  2, fill: "#ef4444" },
  { range: "20%", count:  2, fill: "#ef4444" },
  { range: "30%", count:  3, fill: "#f59e0b" },
  { range: "40%", count:  5, fill: "#f59e0b" },
  { range: "50%", count:  8, fill: "#f59e0b" },
  { range: "60%", count: 12, fill: "#22d3ee" },
  { range: "70%", count: 19, fill: "#22d3ee" },
  { range: "80%", count: 24, fill: "#34d399" },
  { range: "90%", count: 17, fill: "#34d399" },
];
const SEED_CORR_SOURCES = ["hackernews", "reddit", "gdelt", "pubmed"];
const SEED_CORR_MATRIX: Record<string, Partial<Record<string, number>>> = {
  hackernews: { ORG: 12, URL: 18, CVE: 8,  IP: 6,  HASH: 4, GEO: 3 },
  reddit:     { PERSON: 14, ORG: 9, EVENT: 7, GEO: 5, URL: 6, CVE: 3 },
  gdelt:      { GEO: 22, EVENT: 16, ORG: 11, PERSON: 8, DATE: 9, MONEY: 5 },
  pubmed:     { ORG: 15, PERSON: 12, DATE: 11, EVENT: 9, GEO: 7, MONEY: 6 },
};
function buildSeedCorrCells() {
  const cells: Array<{ source: string; kind: string; count: number; intensity: number }> = [];
  for (const src of SEED_CORR_SOURCES) {
    const row = SEED_CORR_MATRIX[src] ?? {};
    const maxVal = Math.max(1, ...Object.values(row));
    for (const kind of ALL_KINDS) {
      const count = row[kind] ?? 0;
      cells.push({ source: src, kind, count, intensity: count / maxVal });
    }
  }
  return cells;
}
const SEED_SCATTER: Array<{ kind: string; confidence: number; count: number; fill: string }> = [
  { kind: "ORG",    confidence: 72, count: 28, fill: "#22d3ee" },
  { kind: "GEO",    confidence: 76, count: 21, fill: "#34d399" },
  { kind: "PERSON", confidence: 68, count: 17, fill: "#60a5fa" },
  { kind: "URL",    confidence: 88, count: 14, fill: "#f59e0b" },
  { kind: "CVE",    confidence: 93, count: 11, fill: "#f87171" },
  { kind: "IP",     confidence: 91, count:  9, fill: "#fb7185" },
  { kind: "EVENT",  confidence: 65, count:  8, fill: "#fbbf24" },
  { kind: "DATE",   confidence: 82, count:  6, fill: "#93c5fd" },
  { kind: "EMAIL",  confidence: 89, count:  5, fill: "#fcd34d" },
  { kind: "HASH",   confidence: 86, count:  4, fill: "#e11d48" },
  { kind: "MONEY",  confidence: 84, count:  3, fill: "#86efac" },
];
const SEED_RADIAL = [
  { name: "ORG",    count: 28, fill: "#22d3ee" },
  { name: "GEO",    count: 21, fill: "#34d399" },
  { name: "PERSON", count: 17, fill: "#60a5fa" },
  { name: "URL",    count: 14, fill: "#f59e0b" },
  { name: "CVE",    count: 11, fill: "#f87171" },
  { name: "IP",     count:  9, fill: "#fb7185" },
  { name: "EVENT",  count:  8, fill: "#fbbf24" },
  { name: "DATE",   count:  6, fill: "#93c5fd" },
];

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

interface ScatterPoint {
  kind: string;
  confidence: number; // 0-100
  count: number;
  fill: string;
}

interface RadialEntry {
  name: string;
  count: number;
  fill: string;
}

interface FunnelState {
  crawled: number;
  withEntities: number;
  entities: number;
  highConf: number;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function IntelligenceAnalytics() {
  const [treemapData, setTreemapData] = useState<TreemapEntry[]>(SEED_TREEMAP);
  const [confBuckets, setConfBuckets] = useState<ConfBucket[]>(SEED_CONF_BUCKETS);
  const [timeline, setTimeline] = useState<TimelinePoint[]>(() => {
    const now = Date.now();
    return Array.from({ length: 10 }, (_, i) => ({
      t: new Date(now - (9 - i) * 68_000).toLocaleTimeString("en-GB", { hour12: false }),
      ORG:    4 + ((i * 3) % 5),
      GEO:    3 + ((i * 2) % 4),
      PERSON: 2 + (i % 3),
      CVE:    1 + (i % 2),
      URL:    5 + ((i * 4) % 6),
    }));
  });
  const [funnelData, setFunnelData] = useState<FunnelEntry[]>([
    { name: "Crawled",     value: 420, fill: FUNNEL_FILLS[0] },
    { name: "w/ Entities", value: 198, fill: FUNNEL_FILLS[1] },
    { name: "Extracted",   value:  91, fill: FUNNEL_FILLS[2] },
    { name: "High Conf",   value:  68, fill: FUNNEL_FILLS[3] },
  ]);
  const [correlationSources, setCorrelationSources] = useState<string[]>(SEED_CORR_SOURCES);
  const [correlationCells, setCorrelationCells] = useState<
    Array<{ source: string; kind: string; count: number; intensity: number }>
  >(buildSeedCorrCells);
  const [scatterData, setScatterData] = useState<ScatterPoint[]>(SEED_SCATTER);
  const [radialData, setRadialData] = useState<RadialEntry[]>(SEED_RADIAL);

  const kindCountRef = useRef<Map<string, number>>(new Map([
    ["ORG", 28], ["GEO", 21], ["PERSON", 17], ["URL", 14], ["CVE", 11],
    ["IP", 9], ["EVENT", 8], ["DATE", 6], ["EMAIL", 5], ["HASH", 4], ["MONEY", 3],
  ]));
  const correlationRef = useRef<Map<string, Map<string, number>>>(new Map([
    ["hackernews", new Map(Object.entries({ ORG: 12, URL: 18, CVE: 8, IP: 6, HASH: 4, GEO: 3 }))],
    ["reddit",     new Map(Object.entries({ PERSON: 14, ORG: 9, EVENT: 7, GEO: 5, URL: 6, CVE: 3 }))],
    ["gdelt",      new Map(Object.entries({ GEO: 22, EVENT: 16, ORG: 11, PERSON: 8, DATE: 9, MONEY: 5 }))],
    ["pubmed",     new Map(Object.entries({ ORG: 15, PERSON: 12, DATE: 11, EVENT: 9, GEO: 7, MONEY: 6 }))],
  ]));
  const timelineKindsRef = useRef<Set<string>>(new Set(["ORG", "GEO", "PERSON", "CVE", "URL"]));
  const funnelRef = useRef<FunnelState>({ crawled: 420, withEntities: 198, entities: 91, highConf: 68 });
  const kindConfRef = useRef<Map<string, { sum: number; n: number }>>(new Map([
    ["ORG",    { sum: 72 * 28, n: 28 }], ["GEO",    { sum: 76 * 21, n: 21 }],
    ["PERSON", { sum: 68 * 17, n: 17 }], ["URL",    { sum: 88 * 14, n: 14 }],
    ["CVE",    { sum: 93 * 11, n: 11 }], ["IP",     { sum: 91 * 9,  n: 9  }],
    ["EVENT",  { sum: 65 * 8,  n: 8  }], ["DATE",   { sum: 82 * 6,  n: 6  }],
    ["EMAIL",  { sum: 89 * 5,  n: 5  }], ["HASH",   { sum: 86 * 4,  n: 4  }],
    ["MONEY",  { sum: 84 * 3,  n: 3  }],
  ]));

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
          // track per-kind confidence for scatter chart
          const kc = kindConfRef.current.get(ent.kind) ?? { sum: 0, n: 0 };
          kindConfRef.current.set(ent.kind, { sum: kc.sum + ent.confidence * 100, n: kc.n + 1 });
        }
        funnelRef.current.entities += ent.count;
      }

      const entries: TreemapEntry[] = [];
      kindCountRef.current.forEach((size, name) => {
        entries.push({ name, size, fill: KIND_COLORS[name] ?? "#94a3b8" });
      });
      setTreemapData(entries.sort((a, b) => b.size - a.size));

      // Rebuild radial + scatter from accumulated refs
      const newRadial: RadialEntry[] = [];
      const newScatter: ScatterPoint[] = [];
      kindCountRef.current.forEach((cnt, kind) => {
        const fill = KIND_COLORS[kind] ?? "#94a3b8";
        newRadial.push({ name: kind, count: cnt, fill });
        const kc = kindConfRef.current.get(kind);
        if (kc && kc.n > 0) {
          newScatter.push({ kind, confidence: Math.round(kc.sum / kc.n), count: cnt, fill });
        }
      });
      newRadial.sort((a, b) => b.count - a.count);
      setRadialData(newRadial.slice(0, 8));
      setScatterData(newScatter);

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
  const maxRadial = Math.max(1, ...radialData.map((d) => d.count));

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

      {/* ── Row 3: Radial Distribution · Entity Confidence Scatter ──── */}
      <div className="grid gap-3 xl:grid-cols-2">

        {/* Radial Entity Kind Distribution */}
        <Panel className="border-white/10 bg-black/40">
          <PanelHeader>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-foreground/70">
              <Activity size={11} className="text-cyan-400" aria-hidden />
              Entity Kind Distribution
            </div>
            <span className="text-[9px] uppercase tracking-wider text-muted/40">radial breakdown</span>
          </PanelHeader>
          <PanelBody>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
              <ResponsiveContainer width="100%" height={200}>
                <RadialBarChart
                  cx="50%" cy="50%"
                  innerRadius={18} outerRadius={90}
                  data={radialData.map((d) => ({ ...d, pct: Math.round((d.count / maxRadial) * 100) }))}
                  startAngle={180} endAngle={-180}
                >
                  <RadialBar
                    dataKey="pct"
                    cornerRadius={3}
                    background={{ fill: "rgba(255,255,255,0.03)" }}
                    label={false}
                    isAnimationActive={false}
                  >
                    {radialData.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </RadialBar>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(v: unknown, _n: unknown, props: { payload?: RadialEntry }) => [
                      `${String(props.payload?.count ?? v)} entities`, props.payload?.name ?? "",
                    ] as [string, string]}
                  />
                </RadialBarChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-1 pr-1">
                {radialData.map((d) => (
                  <div key={d.name} className="flex items-center gap-1.5 text-[9px]">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: d.fill }} />
                    <span className="font-mono text-muted/70 w-10">{d.name}</span>
                    <span className="font-bold tabular-nums" style={{ color: d.fill }}>{d.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </PanelBody>
        </Panel>

        {/* Entity Confidence × Count Scatter */}
        <Panel className="border-white/10 bg-black/40">
          <PanelHeader>
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-foreground/70">
              <Zap size={11} className="text-cyan-400" aria-hidden />
              Confidence × Frequency
            </div>
            <span className="text-[9px] uppercase tracking-wider text-muted/40">per entity kind</span>
          </PanelHeader>
          <PanelBody>
            <ResponsiveContainer width="100%" height={200}>
              <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis
                  type="number" dataKey="confidence" name="Confidence"
                  domain={[50, 100]} unit="%"
                  tick={{ fill: "#4b5563", fontSize: 8 }}
                  axisLine={false} tickLine={false}
                  label={{ value: "extraction confidence", position: "insideBottom", offset: -8, fontSize: 7, fill: "#4b5563" }}
                />
                <YAxis
                  type="number" dataKey="count" name="Count"
                  tick={{ fill: "#4b5563", fontSize: 8 }}
                  axisLine={false} tickLine={false}
                  label={{ value: "freq", angle: -90, position: "insideLeft", fontSize: 7, fill: "#4b5563" }}
                />
                <ZAxis type="number" dataKey="count" range={[48, 260]} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ strokeDasharray: "3 3", stroke: "rgba(255,255,255,0.15)" }}
                  content={({ payload }) => {
                    if (!payload?.length) return null;
                    const p = payload[0]?.payload as ScatterPoint | undefined;
                    if (!p) return null;
                    return (
                      <div style={{ background: "#0a0a0f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: "6px", fontSize: "10px", color: "#e2e8f0", padding: "6px 10px" }}>
                        <div style={{ color: p.fill, fontWeight: 700, marginBottom: 2 }}>{p.kind}</div>
                        <div>confidence: {p.confidence}%</div>
                        <div>count: {p.count}</div>
                      </div>
                    );
                  }}
                />
                <Scatter data={scatterData} isAnimationActive={false}>
                  {scatterData.map((entry) => (
                    <Cell key={entry.kind} fill={entry.fill} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
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
