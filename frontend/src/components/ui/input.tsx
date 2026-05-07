import * as React from "react";

import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-border bg-panel px-3 text-sm text-foreground outline-none transition placeholder:text-muted focus:border-white/45 focus:ring-2 focus:ring-white/10",
        className,
      )}
      {...props}
    />
  );
}
