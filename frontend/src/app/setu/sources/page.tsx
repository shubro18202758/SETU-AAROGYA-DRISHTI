"use client";

import { useState } from "react";

import { ProjectPicker, useSetuProjects } from "@/components/setu/project-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { useAsync } from "@/hooks/use-async";
import { setuClient } from "@/lib/setu-client";
import type { ConnectorType, LatencyTier } from "@/types/setu";

const CONNECTOR_TYPES: ConnectorType[] = ["reddit", "youtube", "rss", "telegram", "web", "x_fixture"];
const LATENCY_TIERS: LatencyTier[] = ["realtime", "daily", "weekly"];

export default function SetuSourcesPage() {
  const { selectedProjectId } = useSetuProjects();
  const sourcesQuery = useAsync(
    () => (selectedProjectId ? setuClient.listSources(selectedProjectId) : Promise.resolve([])),
    [selectedProjectId],
  );
  const [name, setName] = useState("");
  const [connectorType, setConnectorType] = useState<ConnectorType>("rss");
  const [latency, setLatency] = useState<LatencyTier>("daily");
  const [paramsText, setParamsText] = useState("{}");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      let connector_params: Record<string, unknown> = {};
      if (paramsText.trim()) {
        try {
          connector_params = JSON.parse(paramsText) as Record<string, unknown>;
        } catch {
          throw new Error("connector_params must be valid JSON");
        }
      }
      await setuClient.createSource(selectedProjectId, {
        name,
        connector_type: connectorType,
        connector_params,
        latency_tier: latency,
        enabled: true,
      });
      setName("");
      setParamsText("{}");
      sourcesQuery.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(sourceId: string) {
    if (!selectedProjectId) return;
    if (!confirm("Delete source?")) return;
    setError(null);
    try {
      await setuClient.deleteSource(selectedProjectId, sourceId);
      sourcesQuery.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  const sources = sourcesQuery.data ?? [];

  return (
    <div className="grid gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Sources</h1>
        <ProjectPicker />
      </div>

      {!selectedProjectId && <p className="text-sm text-muted">Select a project to manage sources.</p>}

      {selectedProjectId && (
        <>
          <Panel>
            <PanelHeader>
              <PanelTitle>Add source</PanelTitle>
            </PanelHeader>
            <PanelBody>
              <form className="grid gap-3 md:grid-cols-2" onSubmit={handleCreate}>
                <label className="grid gap-1 text-xs text-muted">
                  <span className="uppercase tracking-wide">Name</span>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </label>
                <label className="grid gap-1 text-xs text-muted">
                  <span className="uppercase tracking-wide">Connector</span>
                  <select
                    className="h-9 rounded-md border border-border bg-panel px-3 text-sm text-foreground"
                    value={connectorType}
                    onChange={(e) => setConnectorType(e.target.value as ConnectorType)}
                  >
                    {CONNECTOR_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-muted">
                  <span className="uppercase tracking-wide">Latency tier</span>
                  <select
                    className="h-9 rounded-md border border-border bg-panel px-3 text-sm text-foreground"
                    value={latency}
                    onChange={(e) => setLatency(e.target.value as LatencyTier)}
                  >
                    {LATENCY_TIERS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-xs text-muted md:col-span-2">
                  <span className="uppercase tracking-wide">Connector params (JSON)</span>
                  <textarea
                    className="min-h-[72px] w-full rounded-md border border-white/[0.13] bg-black/30 p-2 font-mono text-xs text-foreground"
                    value={paramsText}
                    onChange={(e) => setParamsText(e.target.value)}
                  />
                </label>
                <div className="md:col-span-2 flex items-center justify-end gap-3">
                  {error && <span className="text-xs text-rose-300">{error}</span>}
                  <Button type="submit" disabled={submitting || !name.trim()}>
                    {submitting ? "creating…" : "Add source"}
                  </Button>
                </div>
              </form>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader>
              <PanelTitle>Configured sources ({sources.length})</PanelTitle>
            </PanelHeader>
            <PanelBody>
              {sourcesQuery.loading && <p className="text-sm text-muted">loading…</p>}
              {!sourcesQuery.loading && sources.length === 0 && (
                <p className="text-sm text-muted">No sources yet.</p>
              )}
              <ul className="grid gap-2">
                {sources.map((source) => (
                  <li
                    key={source.id}
                    className="grid gap-1 rounded-md border border-white/5 bg-black/20 p-3 md:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">{source.name}</div>
                      <div className="text-xs text-muted">
                        {source.connector_type} · {source.latency_tier} · health{" "}
                        {(source.health_score * 100).toFixed(0)}% ·{" "}
                        {source.enabled ? "enabled" : "disabled"}
                      </div>
                      {source.last_error && (
                        <div className="mt-1 text-xs text-rose-300">last error: {source.last_error}</div>
                      )}
                      {source.last_success_at && (
                        <div className="mt-1 text-xs text-muted">
                          last success {new Date(source.last_success_at).toLocaleString()}
                        </div>
                      )}
                    </div>
                    <Button size="sm" variant="outline" onClick={() => void handleDelete(source.id)}>
                      delete
                    </Button>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        </>
      )}
    </div>
  );
}
