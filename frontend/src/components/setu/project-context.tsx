"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { useAsync } from "@/hooks/use-async";
import { setuClient } from "@/lib/setu-client";
import type { SetuProject } from "@/types/setu";

interface SetuProjectContextValue {
  projects: SetuProject[];
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  selectProject: (id: string | null) => void;
  selectedProject: SetuProject | null;
  refresh: () => void;
}

const STORAGE_KEY = "setu.selectedProjectId";

const SetuProjectContext = createContext<SetuProjectContextValue | null>(null);

export function SetuProjectProvider({ children }: { children: React.ReactNode }) {
  const { data, loading, error, refresh } = useAsync(() => setuClient.listProjects(), []);
  const projects = data ?? [];
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setSelectedProjectId(stored);
  }, []);

  useEffect(() => {
    if (projects.length === 0) return;
    if (!selectedProjectId || !projects.some((p) => p.id === selectedProjectId)) {
      const first = projects[0];
      if (first) setSelectedProjectId(first.id);
    }
  }, [projects, selectedProjectId]);

  const selectProject = (id: string | null) => {
    setSelectedProjectId(id);
    if (typeof window !== "undefined") {
      if (id) {
        window.localStorage.setItem(STORAGE_KEY, id);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
  };

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const value: SetuProjectContextValue = {
    projects,
    loading,
    error,
    selectedProjectId,
    selectProject,
    selectedProject,
    refresh,
  };

  return <SetuProjectContext.Provider value={value}>{children}</SetuProjectContext.Provider>;
}

export function useSetuProjects(): SetuProjectContextValue {
  const ctx = useContext(SetuProjectContext);
  if (!ctx) {
    throw new Error("useSetuProjects must be used inside <SetuProjectProvider />");
  }
  return ctx;
}

export function ProjectPicker() {
  const { projects, selectedProjectId, selectProject, loading } = useSetuProjects();
  if (loading) return <span className="text-xs text-muted">loading projects…</span>;
  if (projects.length === 0) return <span className="text-xs text-muted">no projects yet</span>;
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="uppercase tracking-wide">Project</span>
      <select
        className="rounded-md border border-white/[0.13] bg-black/40 px-2 py-1 text-xs text-foreground"
        value={selectedProjectId ?? ""}
        onChange={(event) => selectProject(event.target.value || null)}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name} ({project.slug})
          </option>
        ))}
      </select>
    </label>
  );
}
