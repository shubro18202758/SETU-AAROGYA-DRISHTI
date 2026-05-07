"use client";

import Link from "next/link";

import { ProjectPicker, useSetuProjects } from "@/components/setu/project-context";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { useAsync } from "@/hooks/use-async";
import { setuClient } from "@/lib/setu-client";
import type { SetuSignal, SignalStatus } from "@/types/setu";

const STATUS_ORDER: SignalStatus[] = ["new", "triaged", "more_data", "confirmed", "rejected"];

export default function SetuOverviewPage() {
  const { selectedProjectId, selectedProject, projects, error: projectError } = useSetuProjects();
  const signalsQuery = useAsync(
    () => (selectedProjectId ? setuClient.listSignals(selectedProjectId, { limit: 200 }) : Promise.resolve([])),
    [selectedProjectId],
  );
  const auditQuery = useAsync(
    () => (selectedProjectId ? setuClient.listAudit({ project_id: selectedProjectId, limit: 5 }) : Promise.resolve([])),
    [selectedProjectId],
  );

  const signals: SetuSignal[] = signalsQuery.data ?? [];
  const counts = aggregateSignalCounts(signals);
  const recentAudit = auditQuery.data ?? [];

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">SETU AAROGYA DRISHTI</h1>
          <p className="text-xs text-muted">
            Real-time social listening for patient experience &amp; safety signals.
          </p>
        </div>
        <ProjectPicker />
      </div>

      {projectError && <ErrorBanner message={projectError} />}
      {projects.length === 0 && !projectError && (
        <Panel>
          <PanelBody>
            <p className="text-sm text-muted">
              No SETU projects yet.{" "}
              <Link href="/setu/projects" className="text-foreground underline">
                Create one to begin.
              </Link>
            </p>
          </PanelBody>
        </Panel>
      )}

      {selectedProject && (
        <div className="grid gap-4 md:grid-cols-3">
          <SummaryCard label="Project" value={selectedProject.name} sub={selectedProject.slug} />
          <SummaryCard
            label="Status"
            value={selectedProject.status}
            sub={`${selectedProject.source_ids.length} sources`}
          />
          <SummaryCard
            label="Signals (last 200)"
            value={String(signals.length)}
            sub={`${counts.new ?? 0} new · ${counts.confirmed ?? 0} confirmed`}
          />
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Signals by status</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <ul className="grid gap-2 text-sm">
              {STATUS_ORDER.map((status) => (
                <li key={status} className="flex items-center justify-between border-b border-white/5 pb-1">
                  <span className="capitalize text-muted">{status.replace("_", " ")}</span>
                  <span className="font-mono text-foreground">{counts[status] ?? 0}</span>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Recent audit entries</PanelTitle>
          </PanelHeader>
          <PanelBody>
            {auditQuery.loading && <p className="text-sm text-muted">loading…</p>}
            {!auditQuery.loading && recentAudit.length === 0 && (
              <p className="text-sm text-muted">No audit entries yet.</p>
            )}
            <ul className="grid gap-2 text-xs">
              {recentAudit.map((entry) => (
                <li key={entry.id} className="rounded-md border border-white/5 bg-black/20 p-2">
                  <div className="flex justify-between text-muted">
                    <span>#{entry.sequence}</span>
                    <time>{new Date(entry.recorded_at).toLocaleString()}</time>
                  </div>
                  <div className="mt-1 text-foreground">{entry.action}</div>
                  <div className="text-muted">{entry.payload_summary}</div>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}

function aggregateSignalCounts(signals: SetuSignal[]): Partial<Record<SignalStatus, number>> {
  const counts: Partial<Record<SignalStatus, number>> = {};
  for (const signal of signals) {
    counts[signal.status] = (counts[signal.status] ?? 0) + 1;
  }
  return counts;
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Panel>
      <PanelBody>
        <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
        <div className="mt-1 truncate text-base font-semibold text-foreground">{value}</div>
        {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
      </PanelBody>
    </Panel>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{message}</div>
  );
}
