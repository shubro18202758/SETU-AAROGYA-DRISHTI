"use client";

import { Activity, Brain, CheckCircle2, Clock3, GitBranch, Globe2, LineChart, MapPin, Radar, ShieldCheck, Target, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import type { GeoGraphSummary } from "@/hooks/use-geo-graph-summary";
import type { LivePulse } from "@/hooks/use-live-pulse";
import { ARGUS_DOCTRINE_SOURCES, buildArgusSignalSnapshot, type ArgusSignalPosture } from "@/lib/argus-prototype";
import { cn, formatNumber } from "@/lib/utils";

type StatusTone = "green" | "cyan" | "amber" | "rose" | "blue";

interface ArgusSignalFusionProps {
  pulse: LivePulse;
  geoSummary: GeoGraphSummary;
}

interface StoredLeadRecord {
  priority: "watch" | "triage" | "urgent";
}

const POSTURES: Array<{ key: ArgusSignalPosture; label: string; icon: LucideIcon }> = [
  { key: "ARGUS", label: "ARGUS", icon: GitBranch },
  { key: "TITAN", label: "TITAN", icon: Radar },
  { key: "Finance", label: "Finance", icon: LineChart },
  { key: "ORACLE", label: "ORACLE", icon: Brain },
];

export function ArgusSignalFusion({ pulse, geoSummary }: ArgusSignalFusionProps) {
  const [focusEntity, setFocusEntity] = useState("Mumbai dengue surveillance zone");
  const [posture, setPosture] = useState<ArgusSignalPosture>("TITAN");
  const [leadRecords, setLeadRecords] = useState<StoredLeadRecord[]>([]);

  useEffect(() => {
    function refreshLeads() {
      setLeadRecords(readStoredLeadRecords());
    }
    refreshLeads();
    const interval = window.setInterval(refreshLeads, 3000);
    window.addEventListener("storage", refreshLeads);
    window.addEventListener("osint:add-lead", refreshLeads);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("storage", refreshLeads);
      window.removeEventListener("osint:add-lead", refreshLeads);
    };
  }, []);

  const urgentCount = leadRecords.filter((record) => record.priority === "urgent").length;
  const snapshot = useMemo(
    () => buildArgusSignalSnapshot({
      focusEntity: focusEntity.trim() || "Watchlist entity",
      posture,
      totalItems: pulse.totalItems,
      sourcesActive: pulse.sourcesActive,
      totalEntities: pulse.totalEntities,
      leadCount: Math.max(pulse.leadCount, leadRecords.length),
      urgentCount: Math.max(pulse.urgentCount, urgentCount),
      geoLocations: geoSummary.status === "ready" ? geoSummary.locations : 0,
      geoRelationships: geoSummary.status === "ready" ? geoSummary.relationships : 0,
    }),
    [focusEntity, geoSummary.locations, geoSummary.relationships, geoSummary.status, leadRecords.length, posture, pulse.leadCount, pulse.sourcesActive, pulse.totalEntities, pulse.totalItems, pulse.urgentCount, urgentCount],
  );

  function promoteSignal() {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent("osint:add-lead", {
      detail: {
        source: "ARGUS signal fusion",
        priority: snapshot.band === "escalate" ? "urgent" : snapshot.band === "triage" ? "triage" : "watch",
        text: [snapshot.signal, snapshot.action, ...snapshot.reasoning].join("\n"),
      },
    }));
  }

  return (
    <Panel className="border-white/[0.10]">
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle>ARGUS Signal Fusion</PanelTitle>
          <div className="truncate text-xs text-muted">Cross-domain entity graph, source weighting, and analyst provenance</div>
        </div>
        <StatusPill tone={bandTone(snapshot.band)}>{snapshot.band}</StatusPill>
      </PanelHeader>
      <PanelBody className="grid gap-3 xl:grid-cols-[0.82fr_1.18fr]">
        <div className="grid gap-3">
          <div className="grid gap-3 rounded-md border border-white/[0.10] bg-black/28 p-3">
            <div className="grid gap-1">
              <label className="text-xs font-semibold uppercase tracking-normal text-muted" htmlFor="argus-focus-entity">Focus entity</label>
              <Input id="argus-focus-entity" value={focusEntity} onChange={(event) => setFocusEntity(event.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {POSTURES.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setPosture(item.key)}
                    className={cn(
                      "grid min-h-16 place-items-center gap-1 rounded-md border px-2 py-2 text-xs font-medium transition",
                      posture === item.key ? "border-white/30 bg-white/[0.10] text-foreground" : "border-border bg-background/60 text-muted hover:bg-white/5 hover:text-foreground",
                    )}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <FusionStat icon={ShieldCheck} label="confidence" value={`${snapshot.confidence}%`} tone={bandTone(snapshot.band)} />
              <FusionStat icon={Activity} label="evidence" value={formatNumber(pulse.totalItems)} tone="green" />
              <FusionStat icon={MapPin} label="GEO arcs" value={geoSummary.status === "ready" ? formatNumber(geoSummary.relationships) : "--"} tone="cyan" />
            </div>
            <Button onClick={promoteSignal} className="justify-center">
              <Target size={15} aria-hidden="true" />
              Promote signal
            </Button>
          </div>

          <div className="grid gap-2 rounded-md border border-border bg-background/35 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-normal text-muted">Reasoning chain</div>
              <StatusPill tone="blue">{snapshot.posture}</StatusPill>
            </div>
            <div className="text-sm font-semibold text-foreground">{snapshot.action}</div>
            <div className="grid gap-2">
              {snapshot.reasoning.map((reason, index) => (
                <div key={reason} className="grid grid-cols-[24px_1fr] gap-2 text-xs leading-5 text-muted">
                  <span className="grid size-6 place-items-center rounded-md border border-white/[0.13] bg-white/[0.06] font-mono text-[10px] text-muted">{index + 1}</span>
                  <span>{reason}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-3">
          <div className="grid gap-2 md:grid-cols-2">
            {snapshot.collectionRequirements.map((requirement) => (
              <div key={requirement.id} className="grid gap-1 rounded-md border border-white/[0.10] bg-black/28 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-foreground/70">{requirement.id}</span>
                  <StatusPill tone={requirementTone(requirement.status)}>{requirement.status}</StatusPill>
                </div>
                <div className="text-sm font-medium text-foreground">{requirement.label}</div>
                <div className="text-xs leading-5 text-muted">{requirement.detail}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-2 rounded-md border border-border bg-background/35 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold uppercase tracking-normal text-muted">Source doctrine</div>
              <StatusPill tone="cyan">{ARGUS_DOCTRINE_SOURCES.length} lanes</StatusPill>
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              {ARGUS_DOCTRINE_SOURCES.map((source) => (
                <div key={source.id} className="grid grid-cols-[28px_1fr_auto] items-center gap-2 rounded-md border border-white/[0.10] bg-black/28 px-2.5 py-2">
                  <span className="grid size-7 place-items-center rounded-md border border-white/[0.10] bg-white/[0.07] text-foreground/70">
                    <SourceIcon sourceId={source.id} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-foreground">{source.name}</span>
                    <span className="block truncate text-[11px] text-muted">{source.role}</span>
                  </span>
                  <span className="grid justify-items-end gap-1">
                    <StatusPill tone={modeTone(source.mode)}>{source.mode}</StatusPill>
                    <span className="font-mono text-[10px] text-muted">{Math.round(source.confidenceBase * 100)}%</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function FusionStat({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: StatusTone }) {
  return (
    <div className={cn("rounded-md border px-2.5 py-2", toneSurface(tone))}>
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-normal opacity-85">
        <Icon size={12} className="shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 font-mono text-lg font-semibold leading-none">{value}</div>
    </div>
  );
}

function SourceIcon({ sourceId }: { sourceId: string }) {
  if (sourceId === "gdelt") {
    return <Globe2 size={14} aria-hidden="true" />;
  }
  if (sourceId === "hn-reddit") {
    return <Workflow size={14} aria-hidden="true" />;
  }
  if (sourceId === "verification") {
    return <CheckCircle2 size={14} aria-hidden="true" />;
  }
  if (sourceId === "edgar-market") {
    return <LineChart size={14} aria-hidden="true" />;
  }
  if (sourceId === "cisa-stix") {
    return <ShieldCheck size={14} aria-hidden="true" />;
  }
  return <Clock3 size={14} aria-hidden="true" />;
}

function bandTone(band: "watch" | "triage" | "escalate"): StatusTone {
  if (band === "escalate") {
    return "rose";
  }
  if (band === "triage") {
    return "amber";
  }
  return "cyan";
}

function requirementTone(status: "satisfied" | "partial" | "open"): StatusTone {
  if (status === "satisfied") {
    return "green";
  }
  if (status === "partial") {
    return "amber";
  }
  return "cyan";
}

function modeTone(mode: "connected" | "modeled" | "analyst"): StatusTone {
  if (mode === "connected") {
    return "green";
  }
  if (mode === "analyst") {
    return "blue";
  }
  return "cyan";
}

function toneSurface(tone: StatusTone): string {
  if (tone === "rose") return "border-white/25 bg-white/[0.09] text-foreground";
  if (tone === "green") return "border-white/20 bg-white/[0.07] text-foreground";
  if (tone === "amber") return "border-white/[0.16] bg-white/[0.06] text-muted";
  if (tone === "blue") return "border-white/[0.14] bg-white/[0.06] text-muted";
  return "border-white/[0.13] bg-white/[0.05] text-muted";
}

function readStoredLeadRecords(): StoredLeadRecord[] {
  try {
    const raw = window.localStorage.getItem("osint.localLeads");
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => {
      if (typeof item === "object" && item !== null) {
        const priority = (item as Record<string, unknown>).priority;
        if (priority === "watch" || priority === "triage" || priority === "urgent") {
          return { priority };
        }
      }
      return { priority: "triage" };
    });
  } catch {
    return [];
  }
}