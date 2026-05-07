import * as React from "react";

import { cn } from "@/lib/utils";

type ProgressTone = "green" | "cyan" | "amber" | "rose";

const toneClasses: Record<ProgressTone, string> = {
  green: "confidence-progress-green",
  cyan: "confidence-progress-cyan",
  amber: "confidence-progress-amber",
  rose: "confidence-progress-rose",
};

export interface ProgressBarProps extends Omit<React.ProgressHTMLAttributes<HTMLProgressElement>, "value"> {
  value: number;
  tone?: ProgressTone;
}

export function ProgressBar({ value, tone = "cyan", className, ...props }: ProgressBarProps) {
  const normalizedValue = Math.min(Math.max(value, 0), 100);
  return <progress value={normalizedValue} max={100} className={cn("confidence-progress", toneClasses[tone], className)} {...props} />;
}
