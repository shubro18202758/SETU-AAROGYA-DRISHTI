"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BellDot,
  Boxes,
  Brain,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  Filter,
  GitBranch,
  Loader2,
  LockKeyhole,
  MapPin,
  Network,
  Play,
  RadioTower,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  UserRound,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { LiveSignals } from "@/components/dashboard/live-signals";

const ThreatIntelMap = dynamic(
  () => import("@/components/dashboard/threat-intel-map").then((m) => ({ default: m.ThreatIntelMap })),
  { ssr: false, loading: () => <div className="h-[560px] animate-pulse rounded-xl bg-white/[0.03]" /> },
);
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatusPill } from "@/components/ui/status-pill";
import { useGeoGraphSummary } from "@/hooks/use-geo-graph-summary";
import { type RuntimeServiceStatus, useSystemStatus } from "@/hooks/use-system-status";
import { cn, formatNumber } from "@/lib/utils";

type StatusTone = "green" | "cyan" | "amber" | "rose" | "blue";
type QueryStatus = "idle" | "loading" | "ready" | "error";
type EntityKind = "PERSON" | "ORG" | "GEO" | "EVENT" | "UNKNOWN";

interface GraphNodeResult {
  id: string;
  kind: EntityKind;
  name: string;
  confidence: number | null;
  sourceCount: number | null;
  lastUpdated: string | null;
}

interface GraphEdgeResult {
  id: string;
  sourceId: string | null;
  destinationId: string | null;
  confidence: number | null;
  evidenceText: string | null;
}

interface GraphRagResult {
  query: string;
  entities: GraphNodeResult[];
  relationships: GraphEdgeResult[];
  seedRelationships: GraphEdgeResult[];
  traversalHops: number;
  vectorTopK: number;
}

const EXPECTED_TOPICS = [
  { name: "osint.raw.events", role: "collector ingress", owner: "ingestion" },
  { name: "osint.enriched.events", role: "LLM-extracted entities", owner: "enrichment" },
  { name: "osint.graph.write", role: "resolved graph batches", owner: "writer" },
  { name: "osint.events.high_confidence", role: "operator signal stream", owner: "API" },
];

const STARTUP_STEPS = [
  { label: "Infrastructure", command: "docker compose up -d redpanda arcadedb" },
  { label: "Local model", command: "ollama pull qwen3.5:4b-q4_K_M" },
  { label: "Model health", command: "Invoke-RestMethod http://localhost:11434/api/tags" },
  { label: "API and UI", command: "docker compose --profile app up -d backend writer-worker frontend" },
  { label: "Workers", command: "docker compose --profile app up -d enrich-worker ingest-worker" },
];

export function GraphRagWorkspace() {
  return (
    <WorkspaceFrame>
      <WorkspaceHero eyebrow="GraphRAG Workbench" icon={Brain} title="Ask the local intelligence graph" description="Query evidence vectors, inspect seed relationships, and traverse connected entities without leaving the analyst console." />
      <GraphRagQueryPanel />
      <section aria-label="Geo-intelligence threat map">
        <ThreatIntelMap />
      </section>
    </WorkspaceFrame>
  );
}

export function StreamsWorkspace() {
  const system = useSystemStatus();
  const backendOnline = system.services.some((service) => service.key === "backend" && service.state === "online");
  const redpanda = findService(system.services, "redpanda");

  return (
    <WorkspaceFrame>
      <WorkspaceHero eyebrow="Stream Operations" icon={Workflow} title="Monitor collection and enrichment flow" description="Track Kafka topics, high-confidence event pushes, and the handoff from collectors to the graph writer." />
      <section className="grid gap-3 xl:grid-cols-[0.9fr_1.5fr]">
        <Panel>
          <PanelHeader>
            <PanelTitle>Event Bus Topology</PanelTitle>
            <StatusPill tone={serviceTone(redpanda?.state)}>{redpanda?.state ?? "unknown"}</StatusPill>
          </PanelHeader>
          <PanelBody className="grid gap-2">
            {EXPECTED_TOPICS.map((topic) => (
              <div key={topic.name} className="grid gap-1 border-b border-border/70 py-2 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-sm text-foreground">{topic.name}</span>
                  <StatusPill tone="cyan">{topic.owner}</StatusPill>
                </div>
                <div className="text-xs text-muted">{topic.role}</div>
              </div>
            ))}
          </PanelBody>
        </Panel>
        <LiveSignals enabled={backendOnline} />
      </section>
    </WorkspaceFrame>
  );
}

export function AlertsWorkspace() {
  const [threshold, setThreshold] = useState(86);
  const [fanout, setFanout] = useState(7);
  const [geoWatch, setGeoWatch] = useState(true);
  const rules = useMemo(
    () => [
      { name: "High-confidence event escalation", detail: `EVENT confidence >= ${threshold}%`, enabled: true, tone: "green" as const },
      { name: "Entity fan-out anomaly", detail: `More than ${fanout} new relationships in one batch`, enabled: true, tone: "amber" as const },
      { name: "GEO watchlist correlation", detail: geoWatch ? "Enabled for resolved GEO nodes" : "Paused by analyst", enabled: geoWatch, tone: geoWatch ? ("cyan" as const) : ("rose" as const) },
    ],
    [fanout, geoWatch, threshold],
  );

  return (
    <WorkspaceFrame>
      <WorkspaceHero eyebrow="Alert Triage" icon={BellDot} title="Rules for analyst attention" description="Tune the confidence and graph-change thresholds that decide which events deserve immediate review." />
      <section className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
        <Panel>
          <PanelHeader>
            <PanelTitle>Rule Controls</PanelTitle>
            <SlidersHorizontal size={16} className="text-accent-cyan" aria-hidden="true" />
          </PanelHeader>
          <PanelBody className="grid gap-4">
            <RangeControl label="Event confidence" value={threshold} min={50} max={99} suffix="%" onChange={setThreshold} />
            <RangeControl label="Relationship fan-out" value={fanout} min={2} max={20} suffix=" edges" onChange={setFanout} />
            <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel-strong/70 px-3 py-2 text-sm">
              <span>
                <span className="block font-medium text-foreground">GEO watchlist correlation</span>
                <span className="block text-xs text-muted">Require GEO nodes to stay visible in alert triage.</span>
              </span>
              <input type="checkbox" checked={geoWatch} onChange={(event) => setGeoWatch(event.target.checked)} />
            </label>
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader>
            <PanelTitle>Active Rules</PanelTitle>
            <StatusPill tone="blue">{rules.filter((rule) => rule.enabled).length} enabled</StatusPill>
          </PanelHeader>
          <PanelBody className="grid gap-2">
            {rules.map((rule) => (
              <div key={rule.name} className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md border border-border bg-panel-strong/70 px-3 py-2">
                <span className="grid size-7 place-items-center rounded-md bg-white/5 text-accent-amber">
                  <AlertTriangle size={15} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{rule.name}</span>
                  <span className="block truncate text-xs text-muted">{rule.detail}</span>
                </span>
                <StatusPill tone={rule.tone}>{rule.enabled ? "armed" : "paused"}</StatusPill>
              </div>
            ))}
          </PanelBody>
        </Panel>
      </section>
    </WorkspaceFrame>
  );
}

export function EntitiesWorkspace() {
  return (
    <WorkspaceFrame>
      <WorkspaceHero eyebrow="Entity Resolution" icon={Boxes} title="Find and inspect graph entities" description="Use the GraphRAG retrieval path to locate people, organizations, places, and events with confidence and provenance context." />
      <GraphRagQueryPanel mode="entities" />
      <section aria-label="Geo-intelligence threat map">
        <ThreatIntelMap />
      </section>
    </WorkspaceFrame>
  );
}

export function DatabaseWorkspace() {
  const system = useSystemStatus();
  const geo = useGeoGraphSummary();

  return (
    <WorkspaceFrame>
      <WorkspaceHero eyebrow="Database Fabric" icon={Database} title="ArcadeDB graph, document, and vector state" description="Inspect the local persistence layer, schema contracts, and runtime health for the intelligence graph." />
      <section className="grid gap-3 xl:grid-cols-[0.95fr_1.05fr]">
        <Panel>
          <PanelHeader>
            <PanelTitle>Service Health</PanelTitle>
            <StatusPill tone={summaryTone(system.summary.state)}>{system.summary.state}</StatusPill>
          </PanelHeader>
          <PanelBody className="grid gap-2">
            {system.services.length === 0 ? <EmptyState icon={Database} message="Waiting for status probes." /> : null}
            {system.services.map((service) => (
              <ServiceLine key={service.key} service={service} />
            ))}
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader>
            <PanelTitle>Graph Contract</PanelTitle>
            <StatusPill tone={geo.status === "ready" ? "green" : geo.status === "error" ? "rose" : "amber"}>{geo.status}</StatusPill>
          </PanelHeader>
          <PanelBody className="grid gap-3">
            <SchemaLine name="Entity" fields="id, entity_type, canonical_name, confidence, source_count, last_updated" />
            <SchemaLine name="SemanticRelationship" fields="relationship_uid, source_entity_id, destination_entity_id, evidence_text, evidence_embedding" />
            <div className="grid grid-cols-3 gap-2 text-sm">
              <MiniStat label="GEO" value={geo.status === "loading" ? "--" : formatNumber(geo.locations)} />
              <MiniStat label="Linked" value={geo.status === "loading" ? "--" : formatNumber(geo.connectedEntities)} />
              <MiniStat label="Edges" value={geo.status === "loading" ? "--" : formatNumber(geo.relationships)} />
            </div>
          </PanelBody>
        </Panel>
      </section>
    </WorkspaceFrame>
  );
}

export function ReportsWorkspace() {
  const [caseName, setCaseName] = useState("Untitled OSINT case");
  const [includeGraph, setIncludeGraph] = useState(true);
  const [includeGeo, setIncludeGeo] = useState(true);
  const [includeSignals, setIncludeSignals] = useState(true);

  return (
    <WorkspaceFrame>
      <WorkspaceHero eyebrow="Reporting" icon={FileText} title="Build analyst-ready intelligence briefs" description="Compose a case report outline from graph evidence, GEO context, and high-confidence stream signals." />
      <section className="grid gap-3 xl:grid-cols-[0.75fr_1.25fr]">
        <Panel>
          <PanelHeader>
            <PanelTitle>Report Scope</PanelTitle>
            <FileText size={16} className="text-accent-blue" aria-hidden="true" />
          </PanelHeader>
          <PanelBody className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Case name</span>
              <Input value={caseName} onChange={(event) => setCaseName(event.target.value)} />
            </label>
            <ReportToggle label="Entity graph appendix" checked={includeGraph} onChange={setIncludeGraph} />
            <ReportToggle label="GEO correlation map" checked={includeGeo} onChange={setIncludeGeo} />
            <ReportToggle label="Live signal chronology" checked={includeSignals} onChange={setIncludeSignals} />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader>
            <PanelTitle>Brief Outline</PanelTitle>
            <StatusPill tone="cyan">draft</StatusPill>
          </PanelHeader>
          <PanelBody>
            <div className="grid gap-3 rounded-md border border-border bg-background/55 p-4">
              <div>
                <div className="text-xs uppercase text-muted">Case</div>
                <div className="text-lg font-semibold">{caseName.trim() || "Untitled OSINT case"}</div>
              </div>
              <OutlineLine enabled label="Executive summary" />
              <OutlineLine enabled={includeGraph} label="Entity graph findings and confidence notes" />
              <OutlineLine enabled={includeGeo} label="GEO-linked movement and location context" />
              <OutlineLine enabled={includeSignals} label="High-confidence event chronology" />
              <OutlineLine enabled label="Source caveats and analyst review actions" />
            </div>
          </PanelBody>
        </Panel>
      </section>
    </WorkspaceFrame>
  );
}

export function SettingsWorkspace() {
  return (
    <WorkspaceFrame>
      <WorkspaceHero eyebrow="Runtime Settings" icon={Settings} title="Local OSINT startup and constraints" description="Keep the machine honest: stage services, preserve VRAM for Qwen 3.5 4B, and verify each layer before turning on ingestion." />
      <section className="grid gap-3 xl:grid-cols-[1.1fr_0.9fr]">
        <Panel>
          <PanelHeader>
            <PanelTitle>8 GB VRAM Startup Sequence</PanelTitle>
            <TerminalSquare size={16} className="text-accent-cyan" aria-hidden="true" />
          </PanelHeader>
          <PanelBody className="grid gap-2">
            {STARTUP_STEPS.map((step, index) => (
              <div key={step.label} className="grid grid-cols-[28px_1fr] gap-3 rounded-md border border-border bg-panel-strong/70 px-3 py-2">
                <span className="grid size-7 place-items-center rounded-md bg-accent-cyan/10 font-mono text-xs text-accent-cyan">{index + 1}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{step.label}</span>
                  <code className="block overflow-x-auto whitespace-nowrap pt-1 font-mono text-xs text-muted">{step.command}</code>
                </span>
              </div>
            ))}
          </PanelBody>
        </Panel>
        <Panel>
          <PanelHeader>
            <PanelTitle>Safety Constraints</PanelTitle>
            <LockKeyhole size={16} className="text-accent-amber" aria-hidden="true" />
          </PanelHeader>
          <PanelBody className="grid gap-2 text-sm text-muted">
            <ConstraintLine label="Primary model" value="qwen3.5:4b-q4_K_M" />
            <ConstraintLine label="Ollama API" value="http://localhost:11434" />
            <ConstraintLine label="Frontend API" value="NEXT_PUBLIC_API_BASE_URL=http://localhost:8000" />
            <ConstraintLine label="Database" value="ArcadeDB osint graph" />
          </PanelBody>
        </Panel>
      </section>
    </WorkspaceFrame>
  );
}

function GraphRagQueryPanel({ mode = "graphrag" }: { mode?: "graphrag" | "entities" }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<QueryStatus>("idle");
  const [result, setResult] = useState<GraphRagResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runQuery() {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const response = await fetch("/api/intelligence/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: trimmedQuery }),
        cache: "no-store",
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(readError(payload));
      }
      setResult(parseGraphRagResult(payload));
      setStatus("ready");
    } catch (queryError) {
      setResult(null);
      setStatus("error");
      setError(queryError instanceof Error ? queryError.message : "GraphRAG query failed.");
    }
  }

  return (
    <section className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
      <Panel>
        <PanelHeader>
          <PanelTitle>{mode === "entities" ? "Entity Search" : "Query Console"}</PanelTitle>
          <StatusPill tone={queryStatusTone(status)}>{status}</StatusPill>
        </PanelHeader>
        <PanelBody className="grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted">Natural-language lead</span>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find organizations linked to Mumbai port incidents" onKeyDown={(event) => event.key === "Enter" && void runQuery()} />
          </label>
          <Button onClick={() => void runQuery()} disabled={status === "loading" || query.trim().length === 0}>
            {status === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
            Run GraphRAG
          </Button>
          <div className="rounded-md border border-border bg-background/55 p-3 text-xs text-muted">
            Queries hit the local vector search route first, then expand the connected subgraph from seed relationships.
          </div>
          {status === "error" ? <div className="rounded-md border border-accent-rose/35 bg-accent-rose/10 p-3 text-sm text-accent-rose">{error}</div> : null}
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader>
          <PanelTitle>{mode === "entities" ? "Resolved Entities" : "Retrieved Subgraph"}</PanelTitle>
          <StatusPill tone="blue">{result === null ? "0 entities" : `${result.entities.length} entities`}</StatusPill>
        </PanelHeader>
        <PanelBody className="p-0">
          <ScrollArea className="h-[520px] p-3">
            {result === null ? <EmptyState icon={Search} message="Run a query to inspect local graph entities and evidence edges." /> : null}
            {result !== null ? <GraphRagResults result={result} mode={mode} /> : null}
          </ScrollArea>
        </PanelBody>
      </Panel>
    </section>
  );
}

function GraphRagResults({ result, mode }: { result: GraphRagResult; mode: "graphrag" | "entities" }) {
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-3 gap-2 text-sm">
        <MiniStat label="Top K" value={String(result.vectorTopK)} />
        <MiniStat label="Hops" value={String(result.traversalHops)} />
        <MiniStat label="Edges" value={String(result.relationships.length)} />
      </div>
      <div className="grid gap-2">
        {result.entities.length === 0 ? <EmptyState icon={Boxes} message="No entities were returned by the graph." /> : null}
        {result.entities.map((entity) => (
          <EntityLine key={entity.id} entity={entity} />
        ))}
      </div>
      {mode === "graphrag" ? (
        <div className="grid gap-2">
          <div className="text-xs font-semibold uppercase text-muted">Evidence edges</div>
          {result.relationships.slice(0, 10).map((edge) => (
            <EdgeLine key={edge.id} edge={edge} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto grid w-full max-w-[1680px] gap-3 p-3 sm:p-4">{children}</div>;
}

function WorkspaceHero({ eyebrow, icon: Icon, title, description }: { eyebrow: string; icon: LucideIcon; title: string; description: string }) {
  return (
    <section className="rounded-md border border-border bg-panel/95 p-4 shadow-[0_14px_40px_rgba(0,0,0,0.22)]">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="grid gap-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-accent-cyan">
            <Icon size={15} aria-hidden="true" />
            {eyebrow}
          </div>
          <h1 className="text-2xl font-semibold leading-tight text-foreground sm:text-3xl">{title}</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted">{description}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs text-muted">
          <StatusChip icon={ShieldCheck} label="confidence" />
          <StatusChip icon={GitBranch} label="provenance" />
          <StatusChip icon={MapPin} label="geo context" />
        </div>
      </div>
    </section>
  );
}

function EntityLine({ entity }: { entity: GraphNodeResult }) {
  const Icon = entityIcon(entity.kind);
  return (
    <div className="grid grid-cols-[32px_1fr_auto] items-center gap-3 rounded-md border border-border bg-panel-strong/70 px-3 py-2">
      <span className="grid size-8 place-items-center rounded-md bg-white/5 text-accent-cyan">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{entity.name}</span>
        <span className="block truncate font-mono text-xs text-muted">{entity.id}</span>
      </span>
      <span className="grid justify-items-end gap-1">
        <StatusPill tone={entityTone(entity.kind)}>{entity.kind}</StatusPill>
        <span className="text-[11px] text-muted">{formatConfidence(entity.confidence)}</span>
      </span>
    </div>
  );
}

function EdgeLine({ edge }: { edge: GraphEdgeResult }) {
  return (
    <div className="grid gap-1 rounded-md border border-border bg-background/55 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-muted">{edge.sourceId ?? "unknown"} -&gt; {edge.destinationId ?? "unknown"}</span>
        <StatusPill tone="amber">{formatConfidence(edge.confidence)}</StatusPill>
      </div>
      <div className="max-h-10 overflow-hidden text-muted">{edge.evidenceText ?? "No evidence text returned."}</div>
    </div>
  );
}

function ServiceLine({ service }: { service: RuntimeServiceStatus }) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-border/70 py-2 last:border-b-0">
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{service.name}</span>
        <span className="block truncate text-xs text-muted">{service.detail}</span>
      </span>
      <StatusPill tone={serviceTone(service.state)}>{service.state}</StatusPill>
    </div>
  );
}

function SchemaLine({ name, fields }: { name: string; fields: string }) {
  return (
    <div className="grid gap-1 border-b border-border/70 pb-3 last:border-b-0">
      <div className="font-mono text-sm text-accent-cyan">{name}</div>
      <div className="text-xs leading-5 text-muted">{fields}</div>
    </div>
  );
}

function RangeControl({ label, value, min, max, suffix, onChange }: { label: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="flex items-center justify-between gap-3">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-foreground">{value}{suffix}</span>
      </span>
      <input className="accent-[var(--color-accent-cyan)]" type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function ReportToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel-strong/70 px-3 py-2 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function OutlineLine({ enabled, label }: { enabled: boolean; label: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-sm", enabled ? "text-foreground" : "text-muted line-through")}>
      <CheckCircle2 size={15} className={enabled ? "text-accent-green" : "text-muted"} aria-hidden="true" />
      {label}
    </div>
  );
}

function ConstraintLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 border-b border-border/70 py-2 last:border-b-0">
      <span className="text-xs uppercase text-muted">{label}</span>
      <code className="font-mono text-foreground">{value}</code>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-panel-strong/70 px-3 py-2">
      <div className="text-xs uppercase text-muted">{label}</div>
      <div className="font-mono text-xl font-semibold">{value}</div>
    </div>
  );
}

function StatusChip({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center justify-center gap-1 rounded-md border border-border bg-panel-strong/80 px-2 py-1">
      <Icon size={13} className="text-accent-cyan" aria-hidden="true" />
      {label}
    </span>
  );
}

function EmptyState({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="grid min-h-[180px] place-items-center px-4 text-center text-sm text-muted">
      <div className="grid justify-items-center gap-2">
        <Icon size={22} className="text-accent-cyan" aria-hidden="true" />
        <div>{message}</div>
      </div>
    </div>
  );
}

function parseGraphRagResult(payload: unknown): GraphRagResult {
  if (!isRecord(payload)) {
    return emptyGraphRagResult();
  }
  return {
    query: asString(payload.query) ?? "",
    vectorTopK: asNumber(payload.vector_top_k) ?? 0,
    traversalHops: asNumber(payload.traversal_hops) ?? 0,
    entities: Array.isArray(payload.entities) ? payload.entities.map(parseGraphNode).filter((node): node is GraphNodeResult => node !== null) : [],
    relationships: Array.isArray(payload.relationships) ? payload.relationships.map(parseGraphEdge).filter((edge): edge is GraphEdgeResult => edge !== null) : [],
    seedRelationships: Array.isArray(payload.seed_relationships) ? payload.seed_relationships.map(parseGraphEdge).filter((edge): edge is GraphEdgeResult => edge !== null) : [],
  };
}

function parseGraphNode(value: unknown): GraphNodeResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  if (id === null) {
    return null;
  }
  return {
    id,
    kind: parseEntityKind(value.entity_type),
    name: asString(value.canonical_name) ?? id,
    confidence: asNumber(value.confidence),
    sourceCount: asNumber(value.source_count),
    lastUpdated: asString(value.last_updated),
  };
}

function parseGraphEdge(value: unknown): GraphEdgeResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  if (id === null) {
    return null;
  }
  return {
    id,
    sourceId: asString(value.source_entity_id),
    destinationId: asString(value.destination_entity_id),
    confidence: asNumber(value.confidence),
    evidenceText: asString(value.evidence_text),
  };
}

function emptyGraphRagResult(): GraphRagResult {
  return { query: "", entities: [], relationships: [], seedRelationships: [], traversalHops: 0, vectorTopK: 0 };
}

function readError(payload: unknown): string {
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  if (isRecord(payload) && typeof payload.detail === "string") {
    return payload.detail;
  }
  return "GraphRAG query failed.";
}

function parseEntityKind(value: unknown): EntityKind {
  return value === "PERSON" || value === "ORG" || value === "GEO" || value === "EVENT" ? value : "UNKNOWN";
}

function entityIcon(kind: EntityKind): LucideIcon {
  if (kind === "PERSON") {
    return UserRound;
  }
  if (kind === "ORG") {
    return Network;
  }
  if (kind === "GEO") {
    return MapPin;
  }
  if (kind === "EVENT") {
    return Clock3;
  }
  return Filter;
}

function entityTone(kind: EntityKind): StatusTone {
  if (kind === "PERSON" || kind === "GEO") {
    return "cyan";
  }
  if (kind === "ORG") {
    return "blue";
  }
  if (kind === "EVENT") {
    return "amber";
  }
  return "rose";
}

function queryStatusTone(status: QueryStatus): StatusTone {
  if (status === "ready") {
    return "green";
  }
  if (status === "loading") {
    return "amber";
  }
  if (status === "error") {
    return "rose";
  }
  return "cyan";
}

function summaryTone(state: string): StatusTone {
  if (state === "online") {
    return "green";
  }
  if (state === "degraded" || state === "loading") {
    return "amber";
  }
  return "rose";
}

function serviceTone(state: RuntimeServiceStatus["state"] | undefined): StatusTone {
  if (state === "online") {
    return "green";
  }
  if (state === "degraded" || state === "unknown" || state === undefined) {
    return "amber";
  }
  return "rose";
}

function findService(services: RuntimeServiceStatus[], key: RuntimeServiceStatus["key"]): RuntimeServiceStatus | undefined {
  return services.find((service) => service.key === key);
}

function formatConfidence(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
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
