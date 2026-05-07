"use client";

import { useState } from "react";

import { ProjectPicker, useSetuProjects } from "@/components/setu/project-context";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { useAsync } from "@/hooks/use-async";
import { setuClient } from "@/lib/setu-client";
import type { SetuSignal, SignalKind, SignalStatus, TriageAction } from "@/types/setu";

const KIND_OPTIONS: SignalKind[] = ["adr", "trend", "cluster", "misinformation"];
const STATUS_OPTIONS: SignalStatus[] = ["new", "triaged", "more_data", "confirmed", "rejected"];

export default function SetuTriagePage() {
  const { selectedProjectId } = useSetuProjects();
  const [kindFilter, setKindFilter] = useState<SignalKind | "">("");
  const [statusFilter, setStatusFilter] = useState<SignalStatus | "">("new");

  const signalsQuery = useAsync(
    () => {
      if (!selectedProjectId) return Promise.resolve([]);
      const opts: { kind?: SignalKind; status?: SignalStatus; limit?: number } = { limit: 100 };
      if (kindFilter) opts.kind = kindFilter;
      if (statusFilter) opts.status = statusFilter;
      return setuClient.listSignals(selectedProjectId, opts);
    },
    [selectedProjectId, kindFilter, statusFilter],
  );

  const signals = signalsQuery.data ?? [];

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Triage Queue</h1>
        <div className="flex items-center gap-3">
          <ProjectPicker />
          <FilterSelect
            label="Kind"
            value={kindFilter}
            options={KIND_OPTIONS}
            onChange={(v) => setKindFilter(v as SignalKind | "")}
          />
          <FilterSelect
            label="Status"
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={(v) => setStatusFilter(v as SignalStatus | "")}
          />
          <Button size="sm" variant="outline" onClick={() => signalsQuery.refresh()}>
            refresh
          </Button>
        </div>
      </div>

      {signalsQuery.error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          {signalsQuery.error}
        </div>
      )}

      {!selectedProjectId && <p className="text-sm text-muted">Select a project to view signals.</p>}
      {selectedProjectId && signalsQuery.loading && <p className="text-sm text-muted">loading…</p>}
      {selectedProjectId && !signalsQuery.loading && signals.length === 0 && (
        <p className="text-sm text-muted">No signals match the current filters.</p>
      )}

      <div className="grid gap-3">
        {signals.map((signal) => (
          <SignalCard key={signal.id} signal={signal} onAction={() => signalsQuery.refresh()} />
        ))}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="uppercase tracking-wide">{label}</span>
      <select
        className="rounded-md border border-white/[0.13] bg-black/40 px-2 py-1 text-xs text-foreground"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">all</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function SignalCard({ signal, onAction }: { signal: SetuSignal; onAction: () => void }) {
  const [actor, setActor] = useState("triage@local");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState<TriageAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: TriageAction) {
    setBusy(decision);
    setError(null);
    try {
      await setuClient.triageSignal(signal.id, {
        actor,
        decision,
        rationale: rationale.trim() ? rationale.trim() : null,
      });
      setRationale("");
      onAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "triage failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel>
      <PanelHeader>
        <div className="flex min-w-0 flex-col">
          <PanelTitle>{signal.title}</PanelTitle>
          <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-wide text-muted">
            <span>kind {signal.kind}</span>
            <span>status {signal.status}</span>
            <span>score {signal.score.toFixed(2)}</span>
            {signal.district && <span>district {signal.district}</span>}
            <span>detected {new Date(signal.detected_at).toLocaleString()}</span>
          </div>
        </div>
      </PanelHeader>
      <PanelBody>
        <p className="whitespace-pre-wrap text-sm text-foreground">{signal.explanation}</p>
        {signal.adr_stat && (
          <StatBlock
            heading="ADR statistics"
            rows={[
              ["drug", signal.adr_stat.drug],
              ["event", signal.adr_stat.event],
              ["observed", String(signal.adr_stat.observed)],
              ["expected", signal.adr_stat.expected.toFixed(2)],
              ["PRR", signal.adr_stat.prr.toFixed(2)],
              ["ROR", signal.adr_stat.ror.toFixed(2)],
              ["IC", signal.adr_stat.ic.toFixed(2)],
              ["IC025", signal.adr_stat.ic_lower.toFixed(2)],
            ]}
          />
        )}
        {signal.trend_stat && (
          <StatBlock
            heading="Trend statistics"
            rows={[
              ["keyword", signal.trend_stat.keyword],
              ["z-score", signal.trend_stat.z_score.toFixed(2)],
              ["baseline", signal.trend_stat.baseline.toFixed(2)],
              ["current", signal.trend_stat.current.toFixed(2)],
            ]}
          />
        )}
        {signal.cluster_stat && (
          <StatBlock
            heading="Cluster statistics"
            rows={[
              ["centroid", `${signal.cluster_stat.centroid_lat.toFixed(3)}, ${signal.cluster_stat.centroid_lon.toFixed(3)}`],
              ["radius°", signal.cluster_stat.radius_deg.toFixed(2)],
              ["observed", String(signal.cluster_stat.observed)],
              ["expected", signal.cluster_stat.expected.toFixed(2)],
              ["log-likelihood", signal.cluster_stat.log_likelihood.toFixed(2)],
              ["p-value", signal.cluster_stat.p_value.toFixed(4)],
            ]}
          />
        )}

        <div className="mt-3 grid gap-2 border-t border-white/5 pt-3 md:grid-cols-[160px_minmax(0,1fr)_auto]">
          <input
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder="actor"
            className="h-8 rounded-md border border-white/[0.13] bg-black/30 px-2 text-xs text-foreground"
          />
          <input
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="rationale (optional)"
            className="h-8 rounded-md border border-white/[0.13] bg-black/30 px-2 text-xs text-foreground"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void decide("confirm")} disabled={busy !== null || !actor.trim()}>
              {busy === "confirm" ? "…" : "confirm"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void decide("more_data")}
              disabled={busy !== null || !actor.trim()}
            >
              {busy === "more_data" ? "…" : "more data"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void decide("reject")}
              disabled={busy !== null || !actor.trim()}
            >
              {busy === "reject" ? "…" : "reject"}
            </Button>
          </div>
        </div>
        {error && <div className="mt-2 text-xs text-rose-300">{error}</div>}
      </PanelBody>
    </Panel>
  );
}

function StatBlock({ heading, rows }: { heading: string; rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div className="mt-3 rounded-md border border-white/5 bg-black/20 p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted">{heading}</div>
      <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-muted">{k}</dt>
            <dd className="font-mono text-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
