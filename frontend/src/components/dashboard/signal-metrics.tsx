"use client";

import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Radio,
  ShieldAlert,
  Target,
  TrendingUp,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { cn } from "@/lib/utils";

// ─── Event shape from live-feed-ingestion dispatches ──────────────────────────
interface FeedPulseDetail {
  source: string;
  items: number;
  entities?: Array<{ kind: string; value: string; count: number; confidence?: number }>;
  ok?: boolean;
  query?: string;
}

interface SourceMetricDetail {
  source: string;
  label: string;
  count: number;
  scanned: number;
  latencyMs: number;
  ok: boolean;
  notice?: string;
  fallback?: boolean;
}

interface SourceMetricsEventDetail {
  sources: SourceMetricDetail[];
}

interface EntityItem {
  kind: string;
  value: string;
  count: number;
  confidence?: number;
}

interface EntitiesExtractedDetail {
  entities: EntityItem[];
}

// ─── Internal state shapes ─────────────────────────────────────────────────────
interface TimelinePoint {
  label: string;
  all: number;
  hackernews: number;
  reddit: number;
  gdelt: number;
  pubmed: number;
  who: number;
}

interface SourceSlice {
  name: string;
  value: number;
  fill: string;
}

interface EntityFreqPoint {
  kind: string;
  count: number;
  fill: string;
}

interface ConfBucket {
  label: string;
  count: number;
  fill: string;
}

interface TopEntity {
  name: string;
  count: number;
  kind: string;
  fill: string;
}

interface SourceLatencyPoint {
  name: string;
  latency: number;
  fill: string;
  ok: boolean;
}

interface ThreatDomainPoint {
  axis: string;
  score: number;
}

interface EntityScatterPoint {
  kind: string;
  confidence: number;
  count: number;
  fill: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────
const SOURCE_COLORS: Record<string, string> = {
  all: "#22d3ee",
  hackernews: "#fb923c",
  reddit: "#f87171",
  gdelt: "#60a5fa",
  pubmed: "#34d399",
  who: "#a78bfa",
  unknown: "#94a3b8",
};

const SOURCE_LABELS: Record<string, string> = {
  all: "Multi",
  hackernews: "Open Web",
  reddit: "Community",
  gdelt: "News",
  pubmed: "PubMed",
  who: "WHO/CDC",
};

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

const KIND_ORDER = ["ORG", "PERSON", "GEO", "EVENT", "CVE", "IP", "URL", "EMAIL", "HASH", "MONEY", "DATE"];

const CONF_BUCKET_COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#facc15", "#a3e635",
  "#4ade80", "#34d399", "#2dd4bf", "#22d3ee", "#818cf8",
];

const AREA_SOURCES: Array<{ key: string; color: string }> = [
  { key: "all",        color: "#22d3ee" },
  { key: "pubmed",     color: "#34d399" },
  { key: "who",        color: "#a78bfa" },
  { key: "hackernews", color: "#fb923c" },
  { key: "reddit",     color: "#f87171" },
  { key: "gdelt",      color: "#60a5fa" },
];

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "#09090f",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "6px",
  fontSize: "11px",
  color: "#e2e8f0",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function latencyColor(ms: number): string {
  if (ms < 300) return "#34d399";
  if (ms < 900) return "#fbbf24";
  return "#f87171";
}

function buildConfBuckets(samples: number[]): ConfBucket[] {
  const buckets = Array.from({ length: 10 }, () => 0);
  for (const v of samples) {
    const idx = Math.min(Math.floor(v * 10), 9);
    buckets[idx] = (buckets[idx] ?? 0) + 1;
  }
  return buckets.map((count, i) => ({
    label: `${(i * 0.1).toFixed(1)}`,
    count,
    fill: CONF_BUCKET_COLORS[i] ?? "#94a3b8",
  }));
}

// ─── Seed data (shown before any live queries fire) ──────────────────────────
function makeSeedTimeline(): TimelinePoint[] {
  return Array.from({ length: 10 }, (_, i) => ({
    label: `T${i + 1}`,
    all:        12 + i * 3,
    hackernews:  3 + (i % 4),
    reddit:      2 + (i % 3),
    gdelt:       4 + ((i * 2) % 5),
    pubmed:      2 + (i % 2),
    who:         1 + (i % 2),
  }));
}
const SEED_SOURCE_DIST: SourceSlice[] = [
  { name: "Open Web",  value: 48, fill: "#fb923c" },
  { name: "News",      value: 36, fill: "#60a5fa" },
  { name: "Community", value: 28, fill: "#f87171" },
  { name: "PubMed",    value: 22, fill: "#34d399" },
  { name: "WHO/CDC",   value: 12, fill: "#a78bfa" },
];
const SEED_ENTITY_FREQ: EntityFreqPoint[] = [
  { kind: "ORG",    count: 28, fill: "#22d3ee" },
  { kind: "GEO",    count: 21, fill: "#34d399" },
  { kind: "PERSON", count: 17, fill: "#60a5fa" },
  { kind: "URL",    count: 14, fill: "#f59e0b" },
  { kind: "CVE",    count: 11, fill: "#f87171" },
  { kind: "IP",     count:  9, fill: "#fb7185" },
  { kind: "EVENT",  count:  8, fill: "#fbbf24" },
];
const SEED_TOP_ENTITIES: TopEntity[] = [
  { name: "World Health Organization", count: 12, kind: "ORG",    fill: "#22d3ee" },
  { name: "United States",             count:  9, kind: "GEO",    fill: "#34d399" },
  { name: "CVE-2024-3400",             count:  7, kind: "CVE",    fill: "#f87171" },
  { name: "China",                     count:  6, kind: "GEO",    fill: "#34d399" },
  { name: "Anthony Fauci",             count:  5, kind: "PERSON", fill: "#60a5fa" },
  { name: "192.168.1.1",               count:  4, kind: "IP",     fill: "#fb7185" },
  { name: "Ransomware Campaign",       count:  4, kind: "EVENT",  fill: "#fbbf24" },
];
const SEED_ENTITY_SCATTER: EntityScatterPoint[] = [
  { kind: "ORG",    confidence: 72, count: 28, fill: "#22d3ee" },
  { kind: "GEO",    confidence: 76, count: 21, fill: "#34d399" },
  { kind: "PERSON", confidence: 68, count: 17, fill: "#60a5fa" },
  { kind: "URL",    confidence: 88, count: 14, fill: "#f59e0b" },
  { kind: "CVE",    confidence: 93, count: 11, fill: "#f87171" },
  { kind: "IP",     confidence: 91, count:  9, fill: "#fb7185" },
  { kind: "EVENT",  confidence: 65, count:  8, fill: "#fbbf24" },
];
const SEED_CONF_SAMPLES = [
  0.72, 0.76, 0.65, 0.88, 0.93, 0.91, 0.65, 0.82, 0.89, 0.86,
  0.84, 0.74, 0.78, 0.68, 0.72, 0.85, 0.91, 0.87, 0.65, 0.76,
];
function seedActivityMatrix() {
  return Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const wday = d >= 1 && d <= 5 ? 2 : 1;
      const peak = (h >= 9 && h <= 17) || (h >= 20 && h <= 23) ? 3 : 0;
      return wday + peak + ((d * 7 + h) % 3);
    })
  );
}

// ─── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  sub,
  pulse,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  pulse?: boolean;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-white/8 bg-white/[0.03] px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted">
        {pulse && (
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
          </span>
        )}
        {icon}
        {label}
      </div>
      <div className={cn("text-lg font-bold leading-none tabular-nums", accent ?? "text-foreground")}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sub && <div className="text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

// ─── Section label helper ──────────────────────────────────────────────────────
function SectionLabel({ icon, label, sub }: { icon: React.ReactNode; label: string; sub?: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <span className="text-muted">{icon}</span>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</span>
      {sub && <span className="text-[9px] text-zinc-600">· {sub}</span>}
    </div>
  );
}

// ─── Source health badges ─────────────────────────────────────────────────────
function SourceHealthRow({ latencies }: { latencies: SourceLatencyPoint[] }) {
  if (latencies.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {latencies.map((s) => (
        <div
          key={s.name}
          className="flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px]"
        >
          {s.ok ? (
            <Wifi size={9} className="text-emerald-400" aria-hidden="true" />
          ) : (
            <WifiOff size={9} className="text-rose-400" aria-hidden="true" />
          )}
          <span className="font-medium" style={{ color: SOURCE_COLORS[s.name.toLowerCase()] ?? "#94a3b8" }}>
            {s.name}
          </span>
          <span className="text-muted">{s.latency > 0 ? `${s.latency}ms` : "–"}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Threat Level Gauge ──────────────────────────────────────────────────────
function ThreatLevelGauge({ level }: { level: number }) {
  const color = level >= 75 ? "#f87171" : level >= 50 ? "#fb923c" : level >= 25 ? "#fbbf24" : "#34d399";
  const label = level >= 75 ? "CRITICAL" : level >= 50 ? "HIGH" : level >= 25 ? "ELEVATED" : "NORMAL";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-700"
          style={{ width: `${level}%`, background: `linear-gradient(90deg, #34d399 0%, ${color} 100%)` }}
        />
        {level >= 50 && (
          <div
            className="absolute inset-y-0 left-0 animate-pulse rounded-full opacity-30"
            style={{ width: `${level}%`, background: color, filter: "blur(4px)" }}
          />
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-muted/50">0</span>
        <span className="text-[10px] font-bold tabular-nums" style={{ color }}>
          {label} · {level}/100
        </span>
        <span className="text-[9px] text-muted/50">100</span>
      </div>
    </div>
  );
}

// ─── Velocity Sparkline ──────────────────────────────────────────────────────
function VelocitySparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 0.1);
  const w = 72;
  const h = 18;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible opacity-80">
      <polyline
        points={pts}
        fill="none"
        stroke="#22d3ee"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── Activity Heatmap ────────────────────────────────────────────────────────
const HEATMAP_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ActivityHeatmap({ matrix }: { matrix: number[][] }) {
  const maxVal = Math.max(1, ...matrix.flatMap((r) => r));
  return (
    <div className="flex gap-2 overflow-x-auto">
      <div className="flex shrink-0 flex-col gap-px pt-4">
        {HEATMAP_DAYS.map((d) => (
          <div key={d} className="flex h-3 w-6 items-center text-[7px] text-muted/50">
            {d}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="mb-px grid gap-px"
          style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-center text-[6px] text-muted/40">
              {h % 6 === 0 ? `${h}h` : ""}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-px">
          {matrix.map((row, day) => (
            <div
              key={day}
              className="grid gap-px"
              style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
            >
              {row.map((val, hour) => {
                const intensity = val / maxVal;
                const alpha = val === 0 ? 0.06 : 0.15 + intensity * 0.82;
                const bg =
                  intensity < 0.4
                    ? `rgba(34,211,238,${alpha})`
                    : intensity < 0.75
                      ? `rgba(251,191,36,${alpha})`
                      : `rgba(248,113,113,${alpha})`;
                return (
                  <div
                    key={`${day}-${hour}`}
                    className="h-3 rounded-[2px] transition-colors duration-500"
                    style={{ background: bg }}
                    title={`${HEATMAP_DAYS[day] ?? ""} ${hour}:00 — ${val} signals`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────────
export function SignalMetricsPanel() {
  // ── accumulated state ──────────────────────────────────────────────────────
  const [timeline, setTimeline] = useState<TimelinePoint[]>(makeSeedTimeline);
  const [sourceDist, setSourceDist] = useState<SourceSlice[]>(SEED_SOURCE_DIST);
  const [entityFreq, setEntityFreq] = useState<EntityFreqPoint[]>(SEED_ENTITY_FREQ);
  const [topEntities, setTopEntities] = useState<TopEntity[]>(SEED_TOP_ENTITIES);
  const [confBuckets, setConfBuckets] = useState<ConfBucket[]>(() => buildConfBuckets(SEED_CONF_SAMPLES));
  const [sourceLatency, setSourceLatency] = useState<SourceLatencyPoint[]>([]);

  const [liveCount, setLiveCount] = useState(0);
  const [totalSignals, setTotalSignals] = useState(146);
  const [totalEntities, setTotalEntities] = useState(108);
  const [avgConf, setAvgConf] = useState<number | null>(78);
  const [velocity, setVelocity] = useState<number>(0);
  const [threatLevel, setThreatLevel] = useState(38);
  const [activityMatrix, setActivityMatrix] = useState<number[][]>(seedActivityMatrix);
  const [velocityHistory, setVelocityHistory] = useState<number[]>([0.2, 0.4, 0.8, 1.1, 0.9, 1.4, 1.2, 0.7]);
  const [anomalyAlert, setAnomalyAlert] = useState(false);
  const [threatProfile, setThreatProfile] = useState<ThreatDomainPoint[]>([
    { axis: "CYBER",     score: 62 },
    { axis: "SURV",      score: 38 },
    { axis: "GEO",       score: 71 },
    { axis: "INTEL",     score: 45 },
    { axis: "SITUATION", score: 54 },
    { axis: "NETWORK",   score: 43 },
  ]);
  const [entityScatter, setEntityScatter] = useState<EntityScatterPoint[]>(SEED_ENTITY_SCATTER);

  // ── ref-based accumulators (no re-render per event) ────────────────────────
  const signalBucketRef = useRef<Map<string, number>>(new Map());
  const entityKindRef = useRef<Map<string, number>>(new Map());
  const entityTopRef = useRef<Map<string, { count: number; kind: string }>>(new Map());
  const confSamplesRef = useRef<number[]>([]);
  const kindConfRef = useRef<Map<string, { sum: number; count: number }>>(new Map());
  const latencyMapRef = useRef<Map<string, { sum: number; count: number; ok: boolean }>>(new Map());
  const tickRef = useRef(0);
  const fetchTimestampsRef = useRef<number[]>([]);
  const hasDataRef = useRef(false);

  useEffect(() => {
    // ── osint:feed-pulse ─────────────────────────────────────────────────────
    function handlePulse(ev: Event) {
      const detail = (ev as CustomEvent<FeedPulseDetail>).detail;
      const { source, items, ok } = detail;
      if (!(ok ?? true)) return;

      setLiveCount((n) => n + 1);
      setTotalSignals((n) => n + items);

      // velocity: fetch-rate per minute using last 30 timestamps
      const now = Date.now();
      hasDataRef.current = true;
      fetchTimestampsRef.current = [...fetchTimestampsRef.current.slice(-29), now];
      const oldest = fetchTimestampsRef.current[0];
      if (fetchTimestampsRef.current.length >= 2 && oldest !== undefined) {
        const windowMin = (now - oldest) / 60_000 || 1;
        const newVel = Math.round((fetchTimestampsRef.current.length / windowMin) * 10) / 10;
        setVelocity(newVel);
        setVelocityHistory((prev) => {
          const next = [...prev.slice(-24), newVel];
          if (next.length >= 5) {
            const rollingAvg =
              next.slice(0, -1).reduce((a, b) => a + b, 0) / (next.length - 1);
            setAnomalyAlert(rollingAvg > 0.5 && newVel > rollingAvg * 3);
          }
          return next;
        });
      }

      // activity matrix (hour × day-of-week)
      const nowDate = new Date();
      const actHour = nowDate.getHours();
      const actDow = nowDate.getDay();
      setActivityMatrix((prev) => {
        const next = prev.map((row) => [...row]);
        const row = next[actDow];
        if (row) {
          row[actHour] = (row[actHour] ?? 0) + 1;
        }
        return next;
      });

      // source signal bucket → update dist slices
      const prev = signalBucketRef.current.get(source) ?? 0;
      signalBucketRef.current.set(source, prev + items);
      const slices: SourceSlice[] = [];
      signalBucketRef.current.forEach((val, src) => {
        if (val > 0) {
          slices.push({
            name: SOURCE_LABELS[src] ?? src,
            value: val,
            fill: (SOURCE_COLORS[src] ?? SOURCE_COLORS.unknown) as string,
          });
        }
      });
      setSourceDist(slices);

      // timeline point
      const tick = ++tickRef.current;
      const label =
        tick <= 30
          ? `T${tick}`
          : new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

      setTimeline((prev) => {
        const point: TimelinePoint = {
          label,
          all:        source === "all"        ? items : 0,
          hackernews: source === "hackernews" ? items : 0,
          reddit:     source === "reddit"     ? items : 0,
          gdelt:      source === "gdelt"      ? items : 0,
          pubmed:     source === "pubmed"     ? items : 0,
          who:        source === "who"        ? items : 0,
        };
        return [...prev.slice(-29), point];
      });
    }

    // ── osint:entities-extracted ─────────────────────────────────────────────
    function handleEntities(ev: Event) {
      const detail = (ev as CustomEvent<EntitiesExtractedDetail>).detail;
      const entities = detail.entities ?? [];

      setTotalEntities((n) => n + entities.length);

      for (const ent of entities) {
        entityKindRef.current.set(ent.kind, (entityKindRef.current.get(ent.kind) ?? 0) + 1);
        const topKey = `${ent.kind}:${ent.value.toLowerCase()}`;
        const existing = entityTopRef.current.get(topKey);
        if (existing) {
          existing.count += ent.count;
        } else {
          entityTopRef.current.set(topKey, { count: ent.count, kind: ent.kind });
        }
        if (typeof ent.confidence === "number" && Number.isFinite(ent.confidence)) {
          confSamplesRef.current.push(ent.confidence);
          const kc = kindConfRef.current.get(ent.kind) ?? { sum: 0, count: 0 };
          kindConfRef.current.set(ent.kind, { sum: kc.sum + ent.confidence, count: kc.count + 1 });
        }
      }

      // entity frequency chart
      const freq: EntityFreqPoint[] = [];
      for (const kind of KIND_ORDER) {
        const n = entityKindRef.current.get(kind) ?? 0;
        if (n > 0) freq.push({ kind, count: n, fill: KIND_COLORS[kind] ?? "#94a3b8" });
      }
      setEntityFreq(freq);

      // top 10 entities by cumulative count
      const topArr: TopEntity[] = [];
      entityTopRef.current.forEach((val, key) => {
        const colonIdx = key.indexOf(":");
        const rawValue = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;
        const display = rawValue.charAt(0).toUpperCase() + rawValue.slice(1);
        topArr.push({
          name: display.length > 20 ? display.slice(0, 20) + "…" : display,
          count: val.count,
          kind: val.kind,
          fill: (KIND_COLORS[val.kind] ?? "#94a3b8") as string,
        });
      });
      topArr.sort((a, b) => b.count - a.count);
      setTopEntities(topArr.slice(0, 10));

      // confidence histogram
      setConfBuckets(buildConfBuckets(confSamplesRef.current));

      // running avg confidence
      if (confSamplesRef.current.length > 0) {
        const sum = confSamplesRef.current.reduce((a, b) => a + b, 0);
        setAvgConf(Math.round((sum / confSamplesRef.current.length) * 100));
      }

      // threat level: weighted CVE/IP/HASH/EMAIL composite
      const cveCount = entityKindRef.current.get("CVE") ?? 0;
      const ipCount = entityKindRef.current.get("IP") ?? 0;
      const hashCount = entityKindRef.current.get("HASH") ?? 0;
      const emailCount = entityKindRef.current.get("EMAIL") ?? 0;
      setThreatLevel(
        Math.min(100, Math.round((cveCount * 10 + ipCount * 5 + hashCount * 8 + emailCount * 2) / 2)),
      );

      // threat domain radar
      const kmap = entityKindRef.current;
      const cyber = (kmap.get("CVE") ?? 0) * 4 + (kmap.get("IP") ?? 0) * 3 + (kmap.get("HASH") ?? 0) * 5;
      const surv  = (kmap.get("PERSON") ?? 0) * 2 + (kmap.get("EMAIL") ?? 0) * 3;
      const geo   = (kmap.get("GEO") ?? 0) * 3;
      const intel = (kmap.get("ORG") ?? 0) * 2 + (kmap.get("DATE") ?? 0) + (kmap.get("MONEY") ?? 0) * 2;
      const situation = (kmap.get("EVENT") ?? 0) * 4;
      const network   = (kmap.get("URL") ?? 0) * 2;
      const radarMax = Math.max(1, cyber, surv, geo, intel, situation, network);
      setThreatProfile([
        { axis: "CYBER",     score: Math.round((cyber     / radarMax) * 100) },
        { axis: "SURV",      score: Math.round((surv      / radarMax) * 100) },
        { axis: "GEO",       score: Math.round((geo       / radarMax) * 100) },
        { axis: "INTEL",     score: Math.round((intel     / radarMax) * 100) },
        { axis: "SITUATION", score: Math.round((situation / radarMax) * 100) },
        { axis: "NETWORK",   score: Math.round((network   / radarMax) * 100) },
      ]);

      // scatter: avg confidence × entity count per kind
      const scatter: EntityScatterPoint[] = [];
      kindConfRef.current.forEach((val, kind) => {
        const cnt = kmap.get(kind) ?? 0;
        if (cnt > 0) {
          scatter.push({
            kind,
            confidence: Math.round((val.sum / val.count) * 100),
            count: cnt,
            fill: (KIND_COLORS[kind] ?? "#94a3b8") as string,
          });
        }
      });
      setEntityScatter(scatter);
    }

    // ── osint:source-metrics ─────────────────────────────────────────────────
    function handleSourceMetrics(ev: Event) {
      const detail = (ev as CustomEvent<SourceMetricsEventDetail>).detail;
      for (const sm of detail.sources ?? []) {
        const existing = latencyMapRef.current.get(sm.source) ?? { sum: 0, count: 0, ok: true };
        latencyMapRef.current.set(sm.source, {
          sum: existing.sum + sm.latencyMs,
          count: existing.count + 1,
          ok: sm.ok,
        });
      }
      const latArr: SourceLatencyPoint[] = [];
      latencyMapRef.current.forEach((val, src) => {
        const avgMs = val.count > 0 ? Math.round(val.sum / val.count) : 0;
        latArr.push({
          name: SOURCE_LABELS[src] ?? src,
          latency: avgMs,
          fill: latencyColor(avgMs),
          ok: val.ok,
        });
      });
      latArr.sort((a, b) => a.latency - b.latency);
      setSourceLatency(latArr);
    }

    window.addEventListener("osint:feed-pulse", handlePulse);
    window.addEventListener("osint:entities-extracted", handleEntities);
    window.addEventListener("osint:source-metrics", handleSourceMetrics);
    return () => {
      window.removeEventListener("osint:feed-pulse", handlePulse);
      window.removeEventListener("osint:entities-extracted", handleEntities);
      window.removeEventListener("osint:source-metrics", handleSourceMetrics);
    };
  }, []);

  // Idle drift — subtle live fluctuation between real events
  useEffect(() => {
    const id = setInterval(() => {
      if (!hasDataRef.current) return;
      setVelocity((v) => Math.max(0, +(v + (Math.random() - 0.55) * 0.25).toFixed(1)));
      setThreatLevel((v) => Math.max(0, Math.min(100, v + Math.round((Math.random() - 0.5) * 1.5))));
      setVelocityHistory((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1] ?? 0;
        return [...prev.slice(-24), Math.max(0, +(last + (Math.random() - 0.55) * 0.2).toFixed(1))];
      });
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const hasData = timeline.length > 0 || sourceDist.length > 0;
  const donutTotal = useMemo(() => sourceDist.reduce((sum, s) => sum + s.value, 0), [sourceDist]);
  const hasConf = confBuckets.some((b) => b.count > 0);
  const hasLatency = sourceLatency.length > 0;

  return (
    <Panel className="border-white/10">
      <PanelHeader>
        <PanelTitle>
          <Activity size={14} className="mr-1.5 inline-block align-middle" aria-hidden="true" />
          ARGUS Signal Analytics
        </PanelTitle>
        <div className="flex items-center gap-3 text-[10px] text-muted">
          {velocityHistory.length >= 2 && <VelocitySparkline data={velocityHistory} />}
          <span className={cn("inline-block size-1.5 rounded-full", liveCount > 0 ? "animate-pulse bg-emerald-400" : "bg-zinc-600")} />
          live
        </div>
      </PanelHeader>

      <PanelBody className="flex flex-col gap-5">
        {/* ── Stat strip ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard
            icon={<Radio size={10} aria-hidden="true" />}
            label="Fetches"
            value={liveCount}
            sub="total polling runs"
            pulse={liveCount > 0}
            accent="text-emerald-400"
          />
          <StatCard
            icon={<Activity size={10} aria-hidden="true" />}
            label="Signals"
            value={totalSignals}
            sub="raw items scanned"
            accent="text-cyan-400"
          />
          <StatCard
            icon={<Zap size={10} aria-hidden="true" />}
            label="Entities"
            value={totalEntities}
            sub="named entities found"
            accent="text-violet-400"
          />
          <StatCard
            icon={<Brain size={10} aria-hidden="true" />}
            label="Avg Confidence"
            value={avgConf !== null ? `${avgConf}%` : "–"}
            sub="extraction quality"
            accent={
              avgConf !== null
                ? avgConf >= 70
                  ? "text-emerald-400"
                  : avgConf >= 45
                    ? "text-amber-400"
                    : "text-rose-400"
                : "text-muted"
            }
          />
          <StatCard
            icon={<TrendingUp size={10} aria-hidden="true" />}
            label="Velocity"
            value={velocity > 0 ? `${velocity}/min` : "–"}
            sub="fetch rate"
            accent="text-blue-400"
          />
        </div>

        {/* ── Global Threat Index ──────────────────────────────── */}
        <div className="rounded-md border border-white/8 bg-white/[0.03] px-3 py-2.5">
          <SectionLabel icon={<ShieldAlert size={10} />} label="Global Threat Index" sub="CVE · IP · HASH · EMAIL composite" />
          <ThreatLevelGauge level={threatLevel} />
        </div>

        {/* ── Anomaly alert ────────────────────────────────────── */}
        {anomalyAlert && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="shrink-0 text-amber-400" aria-hidden="true" />
            <span>
              <strong>SIGINT ANOMALY</strong> — velocity spike detected (≥3× rolling avg). Possible burst event in progress.
            </span>
          </div>
        )}

        {!hasData ? (
          <div className="grid min-h-40 place-items-center text-center text-xs text-muted">
            <span className="flex flex-col items-center gap-2">
              <TrendingUp size={26} className="opacity-25" aria-hidden="true" />
              <span>
                Analytics populate as you fetch signals.<br />
                Type a query above and click Fetch.
              </span>
            </span>
          </div>
        ) : (
          <>
            {/* ── Stacked area timeline (full width) ────────────────── */}
            {timeline.length >= 2 && (
              <div>
                <SectionLabel icon={<Activity size={10} />} label="Cumulative Signal Stream" sub="per-source volume over time" />
                <ResponsiveContainer width="100%" height={140}>
                  <AreaChart data={timeline} margin={{ top: 6, right: 8, bottom: 0, left: -24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#4b5563", fontSize: 9 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={{ fill: "#4b5563", fontSize: 9 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#6b7280" }} />
                    <Legend
                      iconType="circle"
                      iconSize={7}
                      formatter={(value) => (
                        <span style={{ fontSize: "9px", color: "#6b7280" }}>
                          {SOURCE_LABELS[value as string] ?? (value as string)}
                        </span>
                      )}
                    />
                    {AREA_SOURCES.map((s) => (
                      <Area
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        stackId="1"
                        stroke={s.color}
                        fill={s.color}
                        fillOpacity={0.45}
                        strokeWidth={1.2}
                        dot={false}
                        name={s.key}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* ── 3-column: Source dist · Entity types · Latency ────── */}
            <div className="grid gap-4 lg:grid-cols-3">
              {sourceDist.length > 0 && (
                <div>
                  <SectionLabel icon={<Radio size={10} />} label="Source Distribution" sub="cumulative signals per origin" />
                  <ResponsiveContainer width="100%" height={175}>
                    <PieChart>
                      <Pie
                        data={sourceDist}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="44%"
                        innerRadius={44}
                        outerRadius={62}
                        paddingAngle={2}
                        labelLine={false}
                        label={false}
                      >
                        {sourceDist.map((entry, index) => (
                          <Cell key={`src-${index}`} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(value: unknown) => [`${String(value)} signals`, ""] as [string, string]}
                      />
                      <Legend
                        iconType="circle"
                        iconSize={7}
                        formatter={(value) => (
                          <span style={{ fontSize: "9px", color: "#6b7280" }}>{value as string}</span>
                        )}
                      />
                      {/* Center text via SVG foreign object trick using recharts label */}
                      <text x="50%" y="40%" textAnchor="middle" dominantBaseline="central" fill="#e2e8f0">
                        <tspan fontSize={18} fontWeight={700}>{donutTotal.toLocaleString()}</tspan>
                      </text>
                      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="#6b7280" fontSize={9}>
                        total signals
                      </text>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}

              {entityFreq.length > 0 && (
                <div>
                  <SectionLabel icon={<Target size={10} />} label="Entity Landscape" sub="cumulative extracted types" />
                  <ResponsiveContainer width="100%" height={175}>
                    <BarChart
                      data={entityFreq}
                      layout="vertical"
                      margin={{ top: 4, right: 24, bottom: 4, left: 0 }}
                      barSize={9}
                    >
                      <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: "#4b5563", fontSize: 8 }} axisLine={false} tickLine={false} />
                      <YAxis
                        type="category"
                        dataKey="kind"
                        tick={{ fill: "#94a3b8", fontSize: 8 }}
                        axisLine={false}
                        tickLine={false}
                        width={36}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(value: unknown) => [`${String(value)} entities`, ""] as [string, string]}
                      />
                      <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                        {entityFreq.map((entry, index) => (
                          <Cell key={`ek-${index}`} fill={(entry.fill ?? "#94a3b8") as string} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {hasLatency && (
                <div>
                  <SectionLabel icon={<Clock size={10} />} label="Source Latency" sub="avg response time (ms)" />
                  <ResponsiveContainer width="100%" height={175}>
                    <BarChart
                      data={sourceLatency}
                      layout="vertical"
                      margin={{ top: 4, right: 32, bottom: 4, left: 0 }}
                      barSize={9}
                    >
                      <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: "#4b5563", fontSize: 8 }} axisLine={false} tickLine={false} unit="ms" />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fill: "#94a3b8", fontSize: 8 }}
                        axisLine={false}
                        tickLine={false}
                        width={52}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(value: unknown) => [`${String(value)} ms avg`, ""] as [string, string]}
                      />
                      <Bar dataKey="latency" radius={[0, 3, 3, 0]}>
                        {sourceLatency.map((entry, index) => (
                          <Cell key={`lat-${index}`} fill={(entry.fill ?? "#94a3b8") as string} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* ── 2-column: Confidence histogram · Top entities ─────── */}
            <div className="grid gap-4 lg:grid-cols-2">
              {hasConf && (
                <div>
                  <SectionLabel icon={<Brain size={10} />} label="Confidence Profile" sub="entity extraction quality distribution" />
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart
                      data={confBuckets}
                      margin={{ top: 4, right: 8, bottom: 0, left: -24 }}
                      barSize={18}
                      barGap={2}
                    >
                      <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.04)" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: "#4b5563", fontSize: 8 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis tick={{ fill: "#4b5563", fontSize: 8 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(value: unknown) => [`${String(value)} entities`, ""] as [string, string]}
                        labelFormatter={(label) => `Conf ≥ ${String(label)}`}
                      />
                      <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                        {confBuckets.map((entry, index) => (
                          <Cell key={`cf-${index}`} fill={(entry.fill ?? "#94a3b8") as string} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {topEntities.length > 0 && (
                <div>
                  <SectionLabel icon={<Zap size={10} />} label="Top Intel Subjects" sub="most cited entities across fetches" />
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart
                      data={topEntities}
                      layout="vertical"
                      margin={{ top: 0, right: 28, bottom: 4, left: 0 }}
                      barSize={8}
                    >
                      <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.04)" horizontal={false} />
                      <XAxis type="number" tick={{ fill: "#4b5563", fontSize: 8 }} axisLine={false} tickLine={false} />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fill: "#94a3b8", fontSize: 8 }}
                        axisLine={false}
                        tickLine={false}
                        width={76}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(value: unknown, _name: unknown, props: { payload?: TopEntity }) => [
                          `${String(value)} citations · ${props.payload?.kind ?? ""}`,
                          "",
                        ] as [string, string]}
                      />
                      <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                        {topEntities.map((entry, index) => (
                          <Cell key={`top-${index}`} fill={(entry.fill ?? "#94a3b8") as string} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* ── Source health badges ───────────────────────────────── */}
            {hasLatency && (
              <div>
                <SectionLabel icon={<CheckCircle2 size={10} />} label="Source Health" sub="live adapter status" />
                <SourceHealthRow latencies={sourceLatency} />
              </div>
            )}

            {/* ── Threat Domain Radar + Entity Confidence Scatter ───── */}
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Radar chart */}
              <div>
                <SectionLabel icon={<ShieldAlert size={10} />} label="Threat Domain Radar" sub="entity-weighted domain profiling" />
                <ResponsiveContainer width="100%" height={200}>
                  <RadarChart data={threatProfile} cx="50%" cy="50%" outerRadius={72}>
                    <PolarGrid stroke="rgba(255,255,255,0.08)" />
                    <PolarAngleAxis
                      dataKey="axis"
                      tick={{ fill: "#6b7280", fontSize: 9 }}
                    />
                    <PolarRadiusAxis
                      angle={90}
                      domain={[0, 100]}
                      tick={{ fill: "#4b5563", fontSize: 7 }}
                      axisLine={false}
                      tickCount={4}
                    />
                    <Radar
                      name="Threat Profile"
                      dataKey="score"
                      stroke="#22d3ee"
                      fill="#22d3ee"
                      fillOpacity={0.18}
                      dot={{ r: 3, fill: "#22d3ee", strokeWidth: 0 }}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value: unknown) => [`${String(value)}/100`, "intensity"] as [string, string]}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>

              {/* Entity confidence × frequency scatter */}
              {entityScatter.length > 0 && (
                <div>
                  <SectionLabel icon={<Target size={10} />} label="Entity Kind Analysis" sub="confidence score vs frequency" />
                  <ResponsiveContainer width="100%" height={200}>
                    <ScatterChart margin={{ top: 8, right: 12, bottom: 8, left: -12 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis
                        type="number"
                        dataKey="confidence"
                        name="Confidence"
                        domain={[0, 100]}
                        tick={{ fill: "#4b5563", fontSize: 8 }}
                        axisLine={false}
                        tickLine={false}
                        unit="%"
                        label={{ value: "confidence", position: "insideBottom", offset: -2, fontSize: 7, fill: "#4b5563" }}
                      />
                      <YAxis
                        type="number"
                        dataKey="count"
                        name="Count"
                        tick={{ fill: "#4b5563", fontSize: 8 }}
                        axisLine={false}
                        tickLine={false}
                        label={{ value: "count", angle: -90, position: "insideLeft", fontSize: 7, fill: "#4b5563" }}
                      />
                      <ZAxis type="number" dataKey="count" range={[40, 200]} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        cursor={{ strokeDasharray: "3 3", stroke: "rgba(255,255,255,0.15)" }}
                        formatter={(value: unknown, name: unknown) => [`${String(value)}${name === "Confidence" ? "%" : ""}`, String(name)] as [string, string]}
                        content={({ payload }) => {
                          if (!payload?.length) return null;
                          const p = payload[0]?.payload as EntityScatterPoint | undefined;
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
                      <Scatter name="Entities" data={entityScatter}>
                        {entityScatter.map((entry) => (
                          <Cell key={entry.kind} fill={entry.fill} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* ── 24h × 7d Activity Heatmap ──────────────────────── */}
            <div>
              <SectionLabel icon={<Activity size={10} />} label="Activity Heatmap" sub="24h × 7d signal volume" />
              <ActivityHeatmap matrix={activityMatrix} />
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

