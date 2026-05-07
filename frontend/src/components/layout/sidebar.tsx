"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  BellDot,
  Boxes,
  Database,
  FileLock2,
  GitGraph,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  MapPinned,
  Plug,
  Radar,
  Settings,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import { StatusPill } from "@/components/ui/status-pill";

const groups = [
  {
    label: "Operate",
    items: [
      { name: "Overview", icon: LayoutDashboard, href: "/" },
      { name: "GraphRAG", icon: GitGraph, href: "/graphrag" },
      { name: "Streams", icon: Workflow, href: "/streams" },
      { name: "Alerts", icon: BellDot, href: "/alerts" },
    ],
  },
  {
    label: "SETU",
    items: [
      { name: "Health Console", icon: HeartPulse, href: "/setu" },
      { name: "Projects", icon: ShieldCheck, href: "/setu/projects" },
      { name: "Triage Queue", icon: Inbox, href: "/setu/triage" },
      { name: "District Map", icon: MapPinned, href: "/setu/map" },
      { name: "Sources", icon: Plug, href: "/setu/sources" },
      { name: "Audit Ledger", icon: FileLock2, href: "/setu/audit" },
    ],
  },
  {
    label: "Data",
    items: [
      { name: "Entities", icon: Boxes, href: "/entities" },
      { name: "Database", icon: Database, href: "/database" },
      { name: "Reports", icon: BarChart3, href: "/reports" },
      { name: "Settings", icon: Settings, href: "/settings" },
    ],
  },
];

export function Sidebar({ status = "loading", headline }: { status?: "online" | "degraded" | "offline" | "loading"; headline?: { tone: "green" | "amber" | "rose" | "cyan"; label: string } }) {
  const pathname = usePathname();
  const pillTone = headline?.tone ?? statusTone(status);
  const pillLabel = headline?.label ?? status;
  return (
    <aside className="relative z-10 hidden min-h-screen border-r border-white/[0.13] bg-black/42 backdrop-blur-xl lg:flex lg:flex-col">
        <div className="flex h-16 items-center justify-between border-b border-white/[0.11] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 place-items-center rounded-md border border-white/[0.13] bg-white/[0.07] text-foreground/80">
            <Radar size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">SETU DRISHTI</div>
            <div className="truncate text-xs text-muted">Health intelligence console</div>
          </div>
        </div>
        <StatusPill tone={pillTone}>{pillLabel}</StatusPill>
      </div>
      <nav className="grid flex-1 content-start gap-5 p-3" aria-label="Primary navigation">
        {groups.map((group) => (
          <div key={group.label} className="grid gap-1">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-normal text-muted">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex h-9 items-center gap-2 rounded-md px-2 text-sm transition ${
                    active ? "bg-white/10 text-foreground" : "text-muted hover:bg-white/5 hover:text-foreground"
                  }`}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="truncate">{item.name}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="m-3 rounded-md border border-border bg-panel-strong/80 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-normal text-muted">Local profile</div>
        <div className="mt-2 grid gap-1 text-xs text-muted">
          <div className="flex justify-between gap-3"><span>Mission</span><span className="font-mono text-foreground">SETU</span></div>
          <div className="flex justify-between gap-3"><span>Runtime</span><span className="font-mono text-foreground">localhost</span></div>
          <div className="flex justify-between gap-3"><span>GPU plan</span><span className="font-mono text-foreground">8 GB VRAM</span></div>
        </div>
      </div>
    </aside>
  );
}

function statusTone(status: "online" | "degraded" | "offline" | "loading"): "green" | "amber" | "rose" {
  if (status === "online") {
    return "green";
  }
  if (status === "degraded" || status === "loading") {
    return "amber";
  }
  return "rose";
}
