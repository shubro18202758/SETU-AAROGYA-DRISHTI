import { OsintShell } from "@/components/layout/osint-shell";
import { GraphRagWorkspace } from "@/components/workspaces/osint-workspaces";

export const runtime = "edge";

export default function GraphRagPage() {
  return (
    <OsintShell>
      <GraphRagWorkspace />
    </OsintShell>
  );
}