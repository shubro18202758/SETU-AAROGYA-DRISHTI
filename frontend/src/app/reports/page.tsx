import { OsintShell } from "@/components/layout/osint-shell";
import { ReportsWorkspace } from "@/components/workspaces/osint-workspaces";

export const runtime = "edge";

export default function ReportsPage() {
  return (
    <OsintShell>
      <ReportsWorkspace />
    </OsintShell>
  );
}