import { AlertsWorkspace } from "@/components/workspaces/osint-workspaces";
import { OsintShell } from "@/components/layout/osint-shell";

export const runtime = "edge";

export default function AlertsPage() {
  return (
    <OsintShell>
      <AlertsWorkspace />
    </OsintShell>
  );
}