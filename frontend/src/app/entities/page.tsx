import { OsintShell } from "@/components/layout/osint-shell";
import { EntitiesWorkspace } from "@/components/workspaces/osint-workspaces";

export const runtime = "edge";

export default function EntitiesPage() {
  return (
    <OsintShell>
      <EntitiesWorkspace />
    </OsintShell>
  );
}