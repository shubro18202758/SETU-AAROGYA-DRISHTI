import { OsintShell } from "@/components/layout/osint-shell";
import { StreamsWorkspace } from "@/components/workspaces/osint-workspaces";

export const runtime = "edge";

export default function StreamsPage() {
  return (
    <OsintShell>
      <StreamsWorkspace />
    </OsintShell>
  );
}