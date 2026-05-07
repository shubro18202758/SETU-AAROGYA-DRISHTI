import { cn } from "@/lib/utils";

export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <kbd className={cn("rounded border border-border bg-white/5 px-1.5 py-0.5 text-[11px] font-medium text-muted", className)}>
      {children}
    </kbd>
  );
}
