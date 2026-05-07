"use client";

import type {
  SetuAuditEntry,
  SetuKeywordSet,
  SetuProject,
  SetuSignal,
  SetuSourceConfig,
  SetuTriageDecision,
  TriageAction,
} from "@/types/setu";

const BASE = "/api/setu";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!response.ok) {
    let detail = `setu request failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (payload?.detail) detail = payload.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const setuClient = {
  listProjects: () => request<SetuProject[]>("/projects"),
  getProject: (id: string) => request<SetuProject>(`/projects/${id}`),
  createProject: (body: {
    slug: string;
    name: string;
    description: string;
    owner: string;
    status?: "active" | "paused" | "archived";
  }) => request<SetuProject>("/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, body: Partial<{ name: string; description: string; status: string }>) =>
    request<SetuProject>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),

  listSources: (projectId: string) => request<SetuSourceConfig[]>(`/projects/${projectId}/sources`),
  createSource: (
    projectId: string,
    body: {
      name: string;
      connector_type: string;
      connector_params?: Record<string, unknown>;
      latency_tier?: string;
      enabled?: boolean;
    },
  ) =>
    request<SetuSourceConfig>(`/projects/${projectId}/sources`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSource: (projectId: string, sourceId: string) =>
    request<void>(`/projects/${projectId}/sources/${sourceId}`, { method: "DELETE" }),

  listKeywordSets: (projectId: string) => request<SetuKeywordSet[]>(`/projects/${projectId}/keywords`),
  createKeywordSet: (
    projectId: string,
    body: { terms: string[]; languages?: string[]; synonyms?: Record<string, string[]> },
  ) =>
    request<SetuKeywordSet>(`/projects/${projectId}/keywords`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listSignals: (projectId: string, params?: { kind?: string; status?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.kind) search.set("kind", params.kind);
    if (params?.status) search.set("status", params.status);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<SetuSignal[]>(`/projects/${projectId}/signals${qs ? `?${qs}` : ""}`);
  },
  getSignal: (signalId: string) => request<SetuSignal>(`/signals/${signalId}`),
  triageSignal: (
    signalId: string,
    body: { actor: string; decision: TriageAction; rationale?: string | null },
  ) =>
    request<SetuSignal>(`/signals/${signalId}/triage`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listTriageHistory: (signalId: string) =>
    request<SetuTriageDecision[]>(`/signals/${signalId}/triage`),

  listAudit: (params?: { project_id?: string; signal_id?: string; limit?: number }) => {
    const search = new URLSearchParams();
    if (params?.project_id) search.set("project_id", params.project_id);
    if (params?.signal_id) search.set("signal_id", params.signal_id);
    if (params?.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<SetuAuditEntry[]>(`/audit${qs ? `?${qs}` : ""}`);
  },
};
