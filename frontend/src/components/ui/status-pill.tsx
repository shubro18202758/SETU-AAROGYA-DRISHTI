import { cn } from "@/lib/utils";

type StatusTone = "green" | "cyan" | "amber" | "rose" | "blue";

const tones: Record<StatusTone, string> = {
  green: "border-white/30 bg-white/10 text-foreground",
  cyan: "border-white/25 bg-white/8 text-foreground",
  amber: "border-white/18 bg-white/6 text-muted",
  rose: "border-white/35 bg-white/12 text-foreground",
  blue: "border-white/22 bg-white/7 text-foreground",
};

export function StatusPill({ tone = "cyan", children }: { tone?: StatusTone; children: React.ReactNode }) {
  return <span className={cn("inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md border px-2 text-xs font-medium", tones[tone])}>{children}</span>;
}
