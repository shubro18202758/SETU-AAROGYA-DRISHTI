import { OsintDashboard } from "@/components/dashboard/osint-dashboard";
import { OsintShell } from "@/components/layout/osint-shell";

export const runtime = "edge";

export default function Page() {
  return (
    <OsintShell>
      <OsintDashboard />
    </OsintShell>
  );
}
