"use client";

import { OsintShell } from "@/components/layout/osint-shell";
import { SetuProjectProvider } from "@/components/setu/project-context";

export default function SetuLayout({ children }: { children: React.ReactNode }) {
  return (
    <OsintShell>
      <SetuProjectProvider>{children}</SetuProjectProvider>
    </OsintShell>
  );
}
