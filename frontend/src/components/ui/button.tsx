import * as React from "react";

import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "ghost" | "outline" | "danger";
type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  default: "border-white/24 bg-white/10 text-foreground hover:border-white/40 hover:bg-white/16",
  ghost: "border-transparent bg-transparent text-muted hover:bg-white/6 hover:text-foreground",
  outline: "border-border bg-panel text-foreground hover:border-white/35 hover:bg-white/8",
  danger: "border-white/35 bg-white/8 text-foreground hover:bg-white/14",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-xs",
  md: "h-9 gap-2 px-3 text-sm",
  icon: "size-8 justify-center p-0",
};

export function Button({ asChild = false, children, className, variant = "default", size = "md", type = "button", ...props }: ButtonProps) {
  const classes = cn(
    "inline-flex shrink-0 items-center rounded-md border font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-white/45 disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    sizes[size],
    className,
  );

  if (asChild && React.isValidElement<{ className?: string }>(children)) {
    return React.cloneElement(children, {
      className: cn(classes, children.props.className),
    });
  }

  return (
    <button
      type={type}
      className={classes}
      {...props}
    >
      {children}
    </button>
  );
}
