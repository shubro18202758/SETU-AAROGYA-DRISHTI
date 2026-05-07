"use client";

import dynamic from "next/dynamic";

import { Panel, PanelBody, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";

const IntelligenceGlobe = dynamic(() => import("./intelligence-globe").then((module) => module.IntelligenceGlobe), {
  ssr: false,
  loading: () => <div className="grid min-h-[520px] place-items-center text-sm text-muted">Loading globe renderer</div>,
});

export function IntelligenceGlobePanel({ className }: { className?: string }) {
  return (
    <Panel className={cn("overflow-hidden", className)}>
      <PanelHeader>
        <div className="min-w-0">
          <PanelTitle>Global Intelligence Globe</PanelTitle>
          <div className="truncate text-xs text-muted">GEO entities and graph relationship arcs</div>
        </div>
        <StatusPill tone="cyan">WebGL</StatusPill>
      </PanelHeader>
      <PanelBody className="p-0">
        <IntelligenceGlobe />
      </PanelBody>
    </Panel>
  );
}
