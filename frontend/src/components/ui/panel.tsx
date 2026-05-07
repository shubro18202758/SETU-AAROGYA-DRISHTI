import * as React from "react";

import { cn } from "@/lib/utils";

export function Panel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <section className={cn("min-w-0 rounded-md border border-white/[0.13] bg-black/32 shadow-[0_22px_70px_rgba(0,0,0,0.38)] backdrop-blur-md", className)} {...props} />;
}

export function PanelHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex min-h-10 items-center justify-between gap-3 border-b border-white/[0.11] bg-white/[0.04] px-3", className)} {...props} />;
}

export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-semibold text-foreground", className)} {...props} />;
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-3", className)} {...props} />;
}
