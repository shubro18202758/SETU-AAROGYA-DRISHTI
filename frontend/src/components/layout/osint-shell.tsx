"use client";

import Link from "next/link";
import { Inbox } from "lucide-react";

import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/osint-notifications";
import { Sidebar } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { useLivePulse } from "@/hooks/use-live-pulse";
import { useSystemStatus } from "@/hooks/use-system-status";

type StatusTone = "green" | "amber" | "rose" | "cyan";

export function OsintShell({ children }: { children: React.ReactNode }) {
  const system = useSystemStatus();
  const pulse = useLivePulse();
  const backendOnline = system.services.some((service) => service.key === "backend" && service.state === "online");
  const headline = deriveHeadline(system.summary.state, pulse.totalItems, pulse.sourcesActive);

  return (
    <div className="relative grid min-h-screen grid-cols-1 overflow-x-hidden bg-transparent text-foreground lg:grid-cols-[260px_minmax(0,1fr)]">
      <div aria-hidden="true" className="osint-neutral-backdrop" />
      <Sidebar status={system.summary.state} headline={headline} />
      <main className="relative z-10 min-w-0">
        <header className="sticky top-0 z-20 border-b border-white/[0.13] bg-black/46 backdrop-blur-xl">
          <div className="flex min-h-14 items-center gap-3 px-3 sm:px-4">
            <CommandPalette enabled={backendOnline} />
            <div className="ml-auto flex items-center gap-2">
              <NotificationBell />
              <StatusPill tone={headline.tone}>{headline.label}</StatusPill>
              <Button asChild size="sm" variant="outline">
                <Link href="/setu/triage">
                  <Inbox size={14} aria-hidden="true" />
                  Triage
                </Link>
              </Button>
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function deriveHeadline(state: string, totalItems: number, sourcesActive: number): { tone: StatusTone; label: string } {
  if (state === "online") return { tone: "green", label: "online" };
  if (totalItems > 0) {
    return { tone: "green", label: `intake \u00b7 ${sourcesActive}/3` };
  }
  if (state === "loading") return { tone: "amber", label: "loading" };
  if (state === "degraded") return { tone: "amber", label: "degraded" };
  return { tone: "cyan", label: "local mode" };
}
