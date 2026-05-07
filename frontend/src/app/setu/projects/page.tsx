"use client";

import { useState } from "react";

import { useSetuProjects } from "@/components/setu/project-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { setuClient } from "@/lib/setu-client";

interface FormState {
  slug: string;
  name: string;
  description: string;
  owner: string;
}

const EMPTY: FormState = { slug: "", name: "", description: "", owner: "" };

export default function SetuProjectsPage() {
  const { projects, loading, refresh, selectProject, selectedProjectId } = useSetuProjects();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await setuClient.createProject(form);
      selectProject(created.id);
      setForm(EMPTY);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "create failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this project? This is not reversible in the in-memory store.")) return;
    setError(null);
    try {
      await setuClient.deleteProject(id);
      if (selectedProjectId === id) selectProject(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
    }
  }

  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-lg font-semibold">SETU Projects</h1>

      <Panel>
        <PanelHeader>
          <PanelTitle>Create project</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <form className="grid gap-3 md:grid-cols-2" onSubmit={handleCreate}>
            <FieldLabel label="Slug">
              <Input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="patient-safety-monsoon"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
              />
            </FieldLabel>
            <FieldLabel label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Patient Safety Monsoon Watch"
                required
              />
            </FieldLabel>
            <FieldLabel label="Owner">
              <Input
                value={form.owner}
                onChange={(e) => setForm({ ...form, owner: e.target.value })}
                placeholder="ops@idsp.gov.in"
                required
              />
            </FieldLabel>
            <FieldLabel label="Description" className="md:col-span-2">
              <textarea
                className="min-h-[64px] w-full rounded-md border border-white/[0.13] bg-black/30 p-2 text-sm text-foreground"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Mission, jurisdictions, escalation contacts…"
                required
              />
            </FieldLabel>
            <div className="md:col-span-2 flex items-center justify-end gap-3">
              {error && <span className="text-xs text-rose-300">{error}</span>}
              <Button type="submit" disabled={submitting}>
                {submitting ? "creating…" : "Create project"}
              </Button>
            </div>
          </form>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Existing projects ({projects.length})</PanelTitle>
        </PanelHeader>
        <PanelBody>
          {loading && <p className="text-sm text-muted">loading…</p>}
          {!loading && projects.length === 0 && (
            <p className="text-sm text-muted">No projects yet — create one above.</p>
          )}
          <ul className="grid gap-2">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-white/5 bg-black/20 p-3"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-foreground">{project.name}</div>
                  <div className="text-xs text-muted">
                    {project.slug} · {project.status} · owner {project.owner} ·{" "}
                    {project.source_ids.length} sources
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={selectedProjectId === project.id ? "default" : "outline"}
                    onClick={() => selectProject(project.id)}
                  >
                    {selectedProjectId === project.id ? "selected" : "select"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void handleDelete(project.id)}>
                    delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </PanelBody>
      </Panel>
    </div>
  );
}

function FieldLabel({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`grid gap-1 text-xs text-muted ${className ?? ""}`}>
      <span className="uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}
