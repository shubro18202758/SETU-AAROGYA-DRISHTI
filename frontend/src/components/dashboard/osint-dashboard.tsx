"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Brain,
  ClipboardList,
  Database,
  FileText,
  GitBranch,
  Globe2,
  MapPin,
  Plus,
  RadioTower,
  Search,
  ServerCog,
  Sparkles,
  Target,
  TerminalSquare,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ArgusSignalFusion } from "@/components/dashboard/argus-signal-fusion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { useAsync } from "@/hooks/use-async";
import { useGeoGraphSummary } from "@/hooks/use-geo-graph-summary";
import { useLivePulse, type LivePulse } from "@/hooks/use-live-pulse";
import { type RuntimeServiceStatus, type ServiceKey, type ServiceState, type SystemStatusSnapshot, useSystemStatus } from "@/hooks/use-system-status";
import { setuClient } from "@/lib/setu-client";
import { cn, formatNumber } from "@/lib/utils";
import type { SetuAuditEntry, SetuProject, SetuSignal, SetuSourceConfig, SignalKind, SignalStatus } from "@/types/setu";

const LiveFeedIngestion = dynamic(
  () => import("@/components/dashboard/live-feed-ingestion").then((module) => module.LiveFeedIngestion),
  {
    ssr: false,
    loading: () => (
      <Panel className="border-white/10">
        <PanelBody>
          <div className="text-sm text-muted">Preparing local intake adapters...</div>
        </PanelBody>
      </Panel>
    ),
  },
);

const SignalMetricsPanel = dynamic(
  () => import("@/components/dashboard/signal-metrics").then((module) => module.SignalMetricsPanel),
  { ssr: false },
);

const ThreatIntelMap = dynamic(
  () => import("@/components/dashboard/threat-intel-map").then((module) => module.ThreatIntelMap),
  { ssr: false },
);

const IntelligenceAnalytics = dynamic(
  () => import("@/components/dashboard/intelligence-analytics").then((module) => module.IntelligenceAnalytics),
  { ssr: false },
);

type StatusTone = "green" | "cyan" | "amber" | "rose" | "blue";
type LeadPriority = "watch" | "triage" | "urgent";

interface LocalLead {
  id: string;
  text: string;
  source: string;
  priority: LeadPriority;
  createdAt: string;
}

interface SetuDashboardState {
  projects: SetuProject[];
  project: SetuProject | null;
  sources: SetuSourceConfig[];
  signals: SetuSignal[];
  audit: SetuAuditEntry[];
  loading: boolean;
  error: string | null;
  statusCounts: Partial<Record<SignalStatus, number>>;
  kindCounts: Partial<Record<SignalKind, number>>;
  sourceCount: number;
  enabledSourceCount: number;
  signalCount: number;
  triageQueueCount: number;
}

const SERVICE_ORDER: Array<{ key: ServiceKey; icon: LucideIcon; fallbackName: string }> = [
  { key: "redpanda", icon: RadioTower, fallbackName: "Redpanda" },
  { key: "llm", icon: Brain, fallbackName: "Qwen 3.5 4B" },
  { key: "arcadedb", icon: Database, fallbackName: "ArcadeDB" },
  { key: "backend", icon: ServerCog, fallbackName: "Intelligence API" },
];

const WORKSPACE_CARDS: Array<{ href: string; label: string; title: string; detail: string; icon: LucideIcon; tone: StatusTone }> = [
  { href: "/setu/triage", label: "Review", title: "Signal Triage", detail: "ADR, trend, cluster, and misinformation queue", icon: ClipboardList, tone: "amber" },
  { href: "/setu/map", label: "Locate", title: "District Clusters", detail: "Poisson grid scan on MapLibre + OSM", icon: MapPin, tone: "cyan" },
  { href: "/setu/sources", label: "Collect", title: "Source Health", detail: "RSS, web, community, and form connectors", icon: RadioTower, tone: "green" },
  { href: "/setu/audit", label: "Trace", title: "Audit Ledger", detail: "Hash-chained analyst and pipeline actions", icon: FileText, tone: "blue" },
];

export function OsintDashboard() {
  const system = useSystemStatus();
  const geoSummary = useGeoGraphSummary();
  const pulse = useLivePulse();
  const projectsQuery = useAsync(() => setuClient.listProjects(), []);
  const projects = projectsQuery.data ?? [];
  const selectedProject = useMemo(() => projects.find((project) => project.status === "active") ?? projects[0] ?? null, [projects]);
  const selectedProjectId = selectedProject?.id ?? null;
  const sourcesQuery = useAsync(
    () => (selectedProjectId ? setuClient.listSources(selectedProjectId) : Promise.resolve([])),
    [selectedProjectId],
  );
  const signalsQuery = useAsync(
    () => (selectedProjectId ? setuClient.listSignals(selectedProjectId, { limit: 200 }) : Promise.resolve([])),
    [selectedProjectId],
  );
  const auditQuery = useAsync(
    () => (selectedProjectId ? setuClient.listAudit({ project_id: selectedProjectId, limit: 8 }) : Promise.resolve([])),
    [selectedProjectId],
  );
  const servicesByKey = useMemo(() => new Map(system.services.map((service) => [service.key, service])), [system.services]);
  const backendOnline = servicesByKey.get("backend")?.state === "online";
  const setu = useMemo(
    () => buildSetuDashboardState({
      projects,
      project: selectedProject,
      sources: sourcesQuery.data ?? [],
      signals: signalsQuery.data ?? [],
      audit: auditQuery.data ?? [],
      loading: projectsQuery.loading || sourcesQuery.loading || signalsQuery.loading || auditQuery.loading,
      error: projectsQuery.error ?? sourcesQuery.error ?? signalsQuery.error ?? auditQuery.error,
    }),
    [
      auditQuery.data,
      auditQuery.error,
      auditQuery.loading,
      projects,
      projectsQuery.error,
      projectsQuery.loading,
      selectedProject,
      signalsQuery.data,
      signalsQuery.error,
      signalsQuery.loading,
      sourcesQuery.data,
      sourcesQuery.error,
      sourcesQuery.loading,
    ],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1680px] gap-3 p-3 sm:p-4">
      <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]" aria-label="Operations command center">
        <OverviewCommandCenter system={system} setu={setu} />
        <LiveOpsBriefing pulse={pulse} setu={setu} />
      </section>

      <section className="min-w-0" aria-label="Public health signal intake">
        <LiveFeedIngestion
          onPromote={(lead) => {
            if (typeof window === "undefined") {
              return;
            }
            window.dispatchEvent(new CustomEvent("osint:add-lead", { detail: lead }));
          }}
        />
      </section>

      <section className="min-w-0" aria-label="Live signal metrics">
        <SignalMetricsPanel />
      </section>

      <section className="min-w-0" aria-label="Intelligence analytics">
        <IntelligenceAnalytics />
      </section>

      <section className="min-w-0" aria-label="Geo-intelligence threat map">
        <ThreatIntelMap />
      </section>

      <section className="min-w-0" aria-label="Evidence graph signal fusion">
        <ArgusSignalFusion pulse={pulse} geoSummary={geoSummary} />
      </section>

      <section className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]" aria-label="Local analyst desk">
        <LocalAnalystDesk backendOnline={backendOnline} />
        <RuntimeFabric servicesByKey={servicesByKey} system={system} />
      </section>

      <WorkspaceLaunchpad />
    </div>
  );
}

function buildSetuDashboardState(input: {
  projects: SetuProject[];
  project: SetuProject | null;
  sources: SetuSourceConfig[];
  signals: SetuSignal[];
  audit: SetuAuditEntry[];
  loading: boolean;
  error: string | null;
}): SetuDashboardState {
  const statusCounts: Partial<Record<SignalStatus, number>> = {};
  const kindCounts: Partial<Record<SignalKind, number>> = {};
  for (const signal of input.signals) {
    statusCounts[signal.status] = (statusCounts[signal.status] ?? 0) + 1;
    kindCounts[signal.kind] = (kindCounts[signal.kind] ?? 0) + 1;
  }
  return {
    ...input,
    statusCounts,
    kindCounts,
    sourceCount: input.sources.length,
    enabledSourceCount: input.sources.filter((source) => source.enabled).length,
    signalCount: input.signals.length,
    triageQueueCount: (statusCounts.new ?? 0) + (statusCounts.more_data ?? 0),
  };
}

function OverviewCommandCenter({ system, setu }: { system: SystemStatusSnapshot; setu: SetuDashboardState }) {
  const operating = setu.signalCount > 0 || setu.enabledSourceCount > 0;
  const headlineTone: StatusTone = setu.error ? "rose" : setu.loading ? "amber" : operating ? "green" : system.summary.state === "loading" ? "amber" : "cyan";
  const headlineLabel = setu.error
    ? "setu api issue"
    : setu.loading
      ? "syncing"
      : setu.project
        ? `${setu.project.status} · ${setu.enabledSourceCount}/${setu.sourceCount} sources`
        : "no project";
  return (
    <Panel className="relative overflow-hidden border-white/[0.10] bg-black/40">
      <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:34px_34px,34px_34px]" />
      <PanelBody className="relative grid gap-5 p-5 lg:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-foreground/65">
            <Activity size={15} aria-hidden="true" />
            SETU AAROGYA DRISHTI
          </div>
          <StatusPill tone={headlineTone}>{headlineLabel}</StatusPill>
        </div>
        <div className="grid gap-2">
          <h1 className="max-w-3xl text-2xl font-semibold leading-tight text-foreground sm:text-3xl lg:text-4xl">Public health signal command center</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted">
            Operational view across SETU projects, monitored sources, ADR disproportionality, trend spikes, district clusters, misinformation review, and hash-chained audit history.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <CommandStat icon={Target} label="Projects" value={setu.loading ? "--" : formatNumber(setu.projects.length)} detail={setu.project?.slug ?? "create project"} tone={setu.project ? "green" : "amber"} />
          <CommandStat icon={Activity} label="Signals" value={setu.loading ? "--" : formatNumber(setu.signalCount)} detail={`${setu.kindCounts.adr ?? 0} ADR · ${setu.kindCounts.trend ?? 0} trend`} tone={setu.signalCount > 0 ? "green" : "amber"} />
          <CommandStat icon={ClipboardList} label="Triage queue" value={setu.loading ? "--" : formatNumber(setu.triageQueueCount)} detail={`${setu.statusCounts.confirmed ?? 0} confirmed`} tone={setu.triageQueueCount > 0 ? "amber" : "cyan"} />
          <CommandStat icon={MapPin} label="District clusters" value={setu.loading ? "--" : formatNumber(setu.kindCounts.cluster ?? 0)} detail={`${setu.sourceCount} monitored sources`} tone={(setu.kindCounts.cluster ?? 0) > 0 ? "cyan" : "blue"} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/setu/triage">
              <ClipboardList size={15} aria-hidden="true" />
              Open triage
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/setu/map">
              <MapPin size={15} aria-hidden="true" />
              District map
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/setu/audit">
              <FileText size={15} aria-hidden="true" />
              Audit ledger
            </Link>
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}

function LiveOpsBriefing({ pulse, setu }: { pulse: LivePulse; setu: SetuDashboardState }) {
  // Re-render every 15s so freshness pills decay even when no events fire.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 15000);
    return () => window.clearInterval(id);
  }, []);
  const visibleSources = setu.sources.slice(0, 4);
  const recentAudit = [...setu.audit].reverse().slice(0, 5);
  return (
    <Panel className="border-white/[0.10] bg-black/32">
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle>SETU Mission Briefing</PanelTitle>
          <div className="truncate text-xs text-muted">{setu.project?.description ?? "Project, source, and signal state from the SETU API"}</div>
        </div>
        <StatusPill tone={setu.error ? "rose" : setu.enabledSourceCount > 0 ? "green" : "amber"}>{setu.enabledSourceCount}/{setu.sourceCount} armed</StatusPill>
      </PanelHeader>
      <PanelBody className="grid gap-3">
        <div className="grid gap-2">
          {visibleSources.length === 0 ? (
            <div className="grid min-h-20 place-items-center rounded-md border border-white/[0.10] bg-black/18 p-3 text-center text-xs text-muted">
              {setu.loading ? "Loading monitored sources..." : "No SETU sources configured yet."}
            </div>
          ) : visibleSources.map((source) => {
            const Icon = connectorIcon(source.connector_type);
            const tone = source.enabled ? sourceTone(source.health_score) : "amber";
            const label = source.enabled ? `${Math.round(source.health_score * 100)}% health` : "paused";
            return (
              <div key={source.id} className="grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md border border-white/[0.11] bg-black/28 px-3 py-2">
                <span className="grid size-7 place-items-center rounded-md border border-white/[0.10] bg-white/[0.07] text-foreground/70">
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{source.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {source.last_success_at ? `last success ${formatRelativeTime(source.last_success_at)}` : source.connector_type} · {source.latency_tier}
                  </span>
                </span>
                <StatusPill tone={tone}>{label}</StatusPill>
              </div>
            );
          })}
        </div>
        <div className="grid gap-1">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-normal text-muted">
            <span>Audit and intake activity</span>
            <span>{recentAudit.length || pulse.activity.length}</span>
          </div>
          <div className="max-h-44 overflow-auto rounded-md border border-white/[0.10] bg-black/18">
            {recentAudit.length > 0 ? (
              <ul className="divide-y divide-border">
                {recentAudit.map((entry) => (
                  <li key={entry.id} className="grid gap-1 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-foreground">{entry.action}</span>
                      <span className="shrink-0 text-[10px] text-muted">#{entry.sequence}</span>
                    </div>
                    <div className="line-clamp-2 text-muted">{entry.payload_summary}</div>
                    <div className="text-[10px] text-muted">{formatRelativeTime(entry.recorded_at)}</div>
                  </li>
                ))}
              </ul>
            ) : pulse.activity.length === 0 ? (
              <div className="grid min-h-20 place-items-center p-3 text-center text-xs text-muted">Audit entries and local intake events will appear here.</div>
            ) : (
              <ul className="divide-y divide-border">
                {pulse.activity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <span className={cn("mt-1 inline-block size-1.5 shrink-0 rounded-full", activityDotClass(entry.tone))} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground">{entry.text}</div>
                      <div className="text-[10px] text-muted">{formatRelativeTime(entry.at)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <Button asChild variant="outline" className="justify-center">
          <Link href="/setu/sources">
            <TerminalSquare size={15} aria-hidden="true" />
            Manage sources
          </Link>
        </Button>
      </PanelBody>
    </Panel>
  );
}

function connectorIcon(connectorType: string): LucideIcon {
  if (connectorType === "rss" || connectorType === "web") return Globe2;
  if (connectorType === "reddit" || connectorType === "telegram") return Workflow;
  return RadioTower;
}

function sourceTone(healthScore: number): StatusTone {
  if (healthScore >= 0.9) return "green";
  if (healthScore >= 0.75) return "amber";
  return "rose";
}

function activityDotClass(tone: "green" | "amber" | "rose" | "cyan" | "blue"): string {
  if (tone === "green") return "bg-accent-green";
  if (tone === "amber") return "bg-accent-amber";
  if (tone === "rose") return "bg-accent-rose";
  if (tone === "blue") return "bg-accent-blue";
  return "bg-accent-cyan";
}

function LocalAnalystDesk({ backendOnline }: { backendOnline: boolean }) {
  const [leadText, setLeadText] = useState("");
  const [leadSource, setLeadSource] = useState("manual note");
  const [priority, setPriority] = useState<LeadPriority>("triage");
  const [leads, setLeads] = useState<LocalLead[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const raw = window.localStorage.getItem("osint.localLeads");
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          setLeads(parsed.map(parseStoredLead).filter((lead): lead is LocalLead => lead !== null));
        }
      } catch {
        setLeads([]);
      }
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) {
      window.localStorage.setItem("osint.localLeads", JSON.stringify(leads));
    }
  }, [leads, loaded]);

  useEffect(() => {
    function handle(event: Event) {
      const detail = (event as CustomEvent<{ text?: unknown; source?: unknown; priority?: unknown }>).detail;
      if (!detail || typeof detail !== "object") {
        return;
      }
      const text = typeof detail.text === "string" ? detail.text.trim() : "";
      if (text.length === 0) {
        return;
      }
      const source = typeof detail.source === "string" && detail.source.length > 0 ? detail.source : "feed";
      const incoming: LeadPriority =
        detail.priority === "watch" || detail.priority === "urgent" || detail.priority === "triage" ? detail.priority : "triage";
      setLeads((current) => [
        { id: createLeadId(), text, source, priority: incoming, createdAt: new Date().toISOString() },
        ...current,
      ]);
    }
    window.addEventListener("osint:add-lead", handle as EventListener);
    return () => window.removeEventListener("osint:add-lead", handle as EventListener);
  }, []);

  function addLead() {
    const text = leadText.trim();
    if (text.length === 0) {
      return;
    }
    setLeads((current) => [
      {
        id: createLeadId(),
        text,
        source: leadSource.trim() || "manual note",
        priority,
        createdAt: new Date().toISOString(),
      },
      ...current,
    ]);
    setLeadText("");
  }

  function removeLead(id: string) {
    setLeads((current) => current.filter((lead) => lead.id !== id));
  }

  const urgentCount = leads.filter((lead) => lead.priority === "urgent").length;
  return (
    <Panel className="border-white/[0.13]">
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle>Analyst Triage Scratchpad</PanelTitle>
          <div className="truncate text-xs text-muted">Capture patient-safety observations before promoting them into the SETU signal workflow.</div>
        </div>
        <StatusPill tone={backendOnline ? "green" : "amber"}>{backendOnline ? "api ready" : "local mode"}</StatusPill>
      </PanelHeader>
      <PanelBody className="grid gap-3 lg:grid-cols-[0.85fr_1.15fr]">
        <div className="grid gap-3 rounded-md border border-white/[0.10] bg-black/28 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList size={16} className="text-foreground/60" aria-hidden="true" />
            Capture a lead
          </div>
          <label className="grid gap-1 text-xs text-muted">
            Lead text
            <textarea
              value={leadText}
              onChange={(event) => setLeadText(event.target.value)}
              placeholder="Paste a symptom report, adverse-event note, district observation, or misinformation claim"
              className="min-h-24 resize-none rounded-md border border-border bg-background/80 px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted/70 focus:border-white/40 focus:ring-2 focus:ring-white/10"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted">
            Source label
            <Input value={leadSource} onChange={(event) => setLeadSource(event.target.value)} placeholder="IDSP bulletin, PvPI note, field call, web capture" />
          </label>
          <div className="grid grid-cols-3 gap-2" aria-label="Lead priority">
            {(["watch", "triage", "urgent"] as LeadPriority[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setPriority(item)}
                className={cn("rounded-md border px-2 py-2 text-xs font-medium capitalize transition", priority === item ? "border-white/30 bg-white/[0.10] text-foreground" : "border-border bg-background/60 text-muted hover:bg-white/5 hover:text-foreground")}
              >
                {item}
              </button>
            ))}
          </div>
          <Button onClick={addLead} disabled={leadText.trim().length === 0} className="justify-center">
            <Plus size={15} aria-hidden="true" />
            Add to local queue
          </Button>
        </div>
        <div className="grid gap-3">
          <div className="grid grid-cols-3 gap-2">
            <MiniDeskStat label="queued" value={String(leads.length)} />
            <MiniDeskStat label="urgent" value={String(urgentCount)} tone="rose" />
            <MiniDeskStat label="mode" value={backendOnline ? "sync" : "local"} tone={backendOnline ? "green" : "amber"} />
          </div>
          <div className="max-h-[340px] overflow-auto rounded-md border border-border bg-background/35">
            {leads.length === 0 ? (
              <div className="grid min-h-52 place-items-center p-5 text-center text-sm text-muted">
                <div className="max-w-sm">
                  <Target size={24} className="mx-auto mb-3 text-foreground/45" aria-hidden="true" />
                  No local observations yet. Add one on the left and the queue updates immediately without waiting for Redpanda or ArcadeDB.
                </div>
              </div>
            ) : (
              <div className="grid gap-2 p-2">
                {leads.map((lead) => (
                  <div key={lead.id} className="grid gap-2 rounded-md border border-white/[0.10] bg-black/28 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="line-clamp-2 text-sm font-medium text-foreground">{lead.text}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                          <span>{lead.source}</span>
                          <span>{formatRelativeTime(lead.createdAt)}</span>
                        </div>
                      </div>
                      <button type="button" onClick={() => removeLead(lead.id)} className="grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted transition hover:border-white/35 hover:text-foreground" aria-label="Remove lead">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <StatusPill tone={priorityTone(lead.priority)}>{lead.priority}</StatusPill>
                      <span className="text-[11px] uppercase tracking-normal text-muted">local health-signal queue</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function RuntimeFabric({ servicesByKey, system }: { servicesByKey: Map<ServiceKey, RuntimeServiceStatus>; system: SystemStatusSnapshot }) {
  const state = system.summary.state;
  const headlineTone: StatusTone = state === "loading" ? "amber" : "green";
  const headlineLabel = state === "loading" ? "loading" : "live";
  return (
    <Panel id="runtime">
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle>Runtime & Data Fabric</PanelTitle>
          <div className="truncate text-xs text-muted">FastAPI, SETU store, optional Redpanda/ArcadeDB, and local model extraction probes.</div>
        </div>
        <StatusPill tone={headlineTone}>{headlineLabel}</StatusPill>
      </PanelHeader>
      <PanelBody className="grid gap-2">
        {SERVICE_ORDER.map((item) => {
          const service = servicesByKey.get(item.key) ?? fallbackService(item.key, item.fallbackName);
          return <PipelineService key={item.key} icon={item.icon} service={service} />;
        })}
      </PanelBody>
    </Panel>
  );
}

function WorkspaceLaunchpad() {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Workspace launchpad">
      {WORKSPACE_CARDS.map((workspace) => {
        const Icon = workspace.icon;
        return (
          <Link key={workspace.href} href={workspace.href} className="group rounded-md border border-white/10 bg-black/42 p-3 transition hover:border-white/25 hover:bg-white/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45">
            <div className="flex items-start justify-between gap-3">
              <span className={cn("grid size-9 place-items-center rounded-md border", toneSurface(workspace.tone))}>
                <Icon size={17} aria-hidden="true" />
              </span>
              <ArrowRight size={15} className="mt-1 text-muted transition group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
            </div>
            <div className="mt-4 grid gap-1">
              <div className="text-[11px] font-semibold uppercase tracking-normal text-muted">{workspace.label}</div>
              <div className="text-base font-semibold text-foreground">{workspace.title}</div>
              <div className="text-xs leading-5 text-muted">{workspace.detail}</div>
            </div>
          </Link>
        );
      })}
    </section>
  );
}

function CommandStat({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone: StatusTone }) {
  return (
    <div className="flex h-full flex-col gap-2 rounded-md border border-white/[0.10] bg-white/[0.04] px-3 py-3 backdrop-blur-sm">
      <span className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-muted">
        <Icon size={14} className="shrink-0 text-foreground/60" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      <div className="font-mono text-2xl font-semibold leading-none text-foreground">{value}</div>
      <div className="mt-auto">
        <span className={cn("inline-block max-w-full break-words rounded-full border px-2 py-0.5 text-[10px] font-medium leading-tight", toneSurface(tone))}>{detail}</span>
      </div>
    </div>
  );
}

function MiniDeskStat({ label, value, tone = "cyan" }: { label: string; value: string; tone?: StatusTone }) {
  return (
    <div className={cn("rounded-md border px-3 py-2", toneSurface(tone))}>
      <div className="text-[11px] font-semibold uppercase tracking-normal opacity-80">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold leading-none">{value}</div>
    </div>
  );
}

function PipelineService({ icon: Icon, service }: { icon: LucideIcon; service: RuntimeServiceStatus }) {
  const displayState = service.state === "unknown" ? "loading" : service.state;
  const displayTone: StatusTone = serviceTone(service.state);
  const displayDetail = service.detail;
  return (
    <div className="grid grid-cols-[34px_1fr_auto] items-center gap-3 rounded-md border border-white/[0.10] bg-black/28 px-2.5 py-2.5">
      <span className="grid size-8 place-items-center rounded-md border border-white/[0.10] bg-white/[0.07] text-foreground/70">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{service.name}</span>
        <span className="block truncate text-xs text-muted">{displayDetail}</span>
      </span>
      <span className="grid justify-items-end gap-1">
        <StatusPill tone={displayTone}>{displayState}</StatusPill>
        <span className="text-[11px] text-muted">{formatLatency(service.latencyMs)}</span>
      </span>
    </div>
  );
}

function fallbackService(key: ServiceKey, fallbackName: string): RuntimeServiceStatus {
  return {
    key,
    name: fallbackName,
    state: "unknown",
    detail: "waiting for probe",
    latencyMs: null,
    checkedAt: new Date().toISOString(),
  };
}

function serviceTone(state: ServiceState): StatusTone {
  if (state === "online") {
    return "green";
  }
  if (state === "degraded" || state === "unknown") {
    return "amber";
  }
  return "rose";
}

function priorityTone(priority: LeadPriority): StatusTone {
  if (priority === "urgent") {
    return "rose";
  }
  if (priority === "watch") {
    return "blue";
  }
  return "amber";
}

function toneSurface(tone: StatusTone): string {
  if (tone === "rose") return "border-white/25 bg-white/[0.09] text-foreground";
  if (tone === "green") return "border-white/20 bg-white/[0.07] text-foreground";
  if (tone === "amber") return "border-white/[0.16] bg-white/[0.06] text-muted";
  if (tone === "blue") return "border-white/[0.14] bg-white/[0.06] text-muted";
  return "border-white/[0.13] bg-white/[0.05] text-muted";
}

function formatLatency(latencyMs: number | null): string {
  return latencyMs === null ? "--" : `${latencyMs}ms`;
}

function formatRelativeTime(timestamp: string): string {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 1000) {
    return "just now";
  }
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function createLeadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseStoredLead(value: unknown): LocalLead | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : null;
  const text = typeof record.text === "string" ? record.text : null;
  const source = typeof record.source === "string" ? record.source : "manual note";
  const priority = record.priority === "watch" || record.priority === "triage" || record.priority === "urgent" ? record.priority : "triage";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString();
  if (id === null || text === null) {
    return null;
  }
  return { id, text, source, priority, createdAt };
}
