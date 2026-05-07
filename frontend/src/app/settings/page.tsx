import { OsintShell } from "@/components/layout/osint-shell";
import { SettingsWorkspace } from "@/components/workspaces/osint-workspaces";

export const runtime = "edge";

export default function SettingsPage() {
  return (
    <OsintShell>
      <SettingsWorkspace />
    </OsintShell>
  );
}