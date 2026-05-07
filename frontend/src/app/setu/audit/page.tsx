"use client";

import { useMemo, useState } from "react";

import { ProjectPicker, useSetuProjects } from "@/components/setu/project-context";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { useAsync } from "@/hooks/use-async";
import { setuClient } from "@/lib/setu-client";
import type { SetuAuditEntry } from "@/types/setu";

interface ChainCheck {
  ok: boolean;
  brokenAt?: number;
}

export default function SetuAuditPage() {
  const { selectedProjectId } = useSetuProjects();
  const auditQuery = useAsync(
    () =>
      setuClient.listAudit(selectedProjectId ? { project_id: selectedProjectId, limit: 200 } : { limit: 200 }),
    [selectedProjectId],
  );
  const [check, setCheck] = useState<ChainCheck | null>(null);

  const entries = useMemo(() => auditQuery.data ?? [], [auditQuery.data]);

  function verify() {
    const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const curr = ordered[i];
      if (!prev || !curr) continue;
      if (curr.prev_hash !== prev.payload_hash) {
        setCheck({ ok: false, brokenAt: curr.sequence });
        return;
      }
    }
    setCheck({ ok: true });
  }

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Audit Ledger</h1>
          <p className="text-xs text-muted">
            BLAKE3-chained audit entries. Each row references the previous payload hash.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ProjectPicker />
          <Button size="sm" variant="outline" onClick={() => auditQuery.refresh()}>
            refresh
          </Button>
          <Button size="sm" onClick={verify} disabled={entries.length === 0}>
            verify chain
          </Button>
        </div>
      </div>

      {check && (
        <div
          className={`rounded-md border p-3 text-sm ${
            check.ok
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/40 bg-rose-500/10 text-rose-200"
          }`}
        >
          {check.ok
            ? `✓ chain verified across ${entries.length} entries`
            : `✗ chain break detected at sequence #${check.brokenAt}`}
        </div>
      )}

      <Panel>
        <PanelHeader>
          <PanelTitle>Entries ({entries.length})</PanelTitle>
        </PanelHeader>
        <PanelBody>
          {auditQuery.loading && <p className="text-sm text-muted">loading…</p>}
          {!auditQuery.loading && entries.length === 0 && (
            <p className="text-sm text-muted">No audit entries.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-white/10 text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">action</th>
                  <th className="py-2 pr-3">actor</th>
                  <th className="py-2 pr-3">signal</th>
                  <th className="py-2 pr-3">summary</th>
                  <th className="py-2 pr-3">recorded</th>
                  <th className="py-2 pr-3">prev_hash</th>
                  <th className="py-2 pr-3">payload_hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry: SetuAuditEntry) => (
                  <tr key={entry.id} className="border-b border-white/5 align-top">
                    <td className="py-2 pr-3 font-mono">{entry.sequence}</td>
                    <td className="py-2 pr-3">{entry.action}</td>
                    <td className="py-2 pr-3">{entry.actor}</td>
                    <td className="py-2 pr-3 font-mono text-muted">
                      {entry.signal_id ? entry.signal_id.slice(0, 8) : "—"}
                    </td>
                    <td className="py-2 pr-3">{entry.payload_summary}</td>
                    <td className="py-2 pr-3 text-muted">
                      {new Date(entry.recorded_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 font-mono text-muted">
                      {entry.prev_hash ? entry.prev_hash.slice(0, 12) : "∅"}
                    </td>
                    <td className="py-2 pr-3 font-mono text-foreground">
                      {entry.payload_hash.slice(0, 12)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
