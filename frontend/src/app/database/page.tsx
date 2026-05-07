import { DatabaseWorkspace } from "@/components/workspaces/osint-workspaces";
import { OsintShell } from "@/components/layout/osint-shell";

export const runtime = "edge";

export default function DatabasePage() {
  return (
    <OsintShell>
      <DatabaseWorkspace />
    </OsintShell>
  );
}