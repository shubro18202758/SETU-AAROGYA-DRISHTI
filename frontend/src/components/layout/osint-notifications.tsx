"use client";

import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCheck,
  Globe2,
  MapPin,
  Radio,
  Shield,
  ShieldAlert,
  Sigma,
  Trash2,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type NotifKind, type NotifSeverity, type OsintNotification, sortBySeverity, useNotifications } from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

// ─── Severity styling ─────────────────────────────────────────────────────────
const SEVERITY_DOT: Record<NotifSeverity, string> = {
  critical: "bg-rose-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.55)]",
  high:     "bg-orange-500 shadow-[0_0_5px_1px_rgba(249,115,22,0.45)]",
  medium:   "bg-amber-400 shadow-[0_0_4px_1px_rgba(251,191,36,0.35)]",
  low:      "bg-cyan-400",
  info:     "bg-slate-400",
};

const SEVERITY_BORDER: Record<NotifSeverity, string> = {
  critical: "border-rose-500/40 bg-rose-950/30",
  high:     "border-orange-500/30 bg-orange-950/20",
  medium:   "border-amber-400/25 bg-amber-900/15",
  low:      "border-cyan-500/20 bg-cyan-950/15",
  info:     "border-white/8 bg-white/[0.02]",
};

const SEVERITY_TITLE: Record<NotifSeverity, string> = {
  critical: "text-rose-300",
  high:     "text-orange-300",
  medium:   "text-amber-200",
  low:      "text-cyan-200",
  info:     "text-slate-300",
};

// ─── Kind icon ────────────────────────────────────────────────────────────────
function KindIcon({ kind, severity }: { kind: NotifKind; severity: NotifSeverity }) {
  const cls = cn(
    "size-4 shrink-0 mt-0.5",
    severity === "critical" ? "text-rose-400" :
    severity === "high"     ? "text-orange-400" :
    severity === "medium"   ? "text-amber-400" :
    severity === "low"      ? "text-cyan-400" :
    "text-slate-400",
  );
  switch (kind) {
    case "threat_alert":    return <ShieldAlert className={cls} aria-hidden />;
    case "source_error":    return <WifiOff     className={cls} aria-hidden />;
    case "signal_burst":    return <Radio       className={cls} aria-hidden />;
    case "rate_spike":      return <Zap         className={cls} aria-hidden />;
    case "geo_ping":        return <MapPin      className={cls} aria-hidden />;
    case "extraction_done": return <Sigma       className={cls} aria-hidden />;
    case "lookup_hit":      return <Shield      className={cls} aria-hidden />;
    default:                return <Bell        className={cls} aria-hidden />;
  }
}

// ─── Single notification row ──────────────────────────────────────────────────
function NotifRow({
  notif,
  onRead,
  onDismiss,
}: {
  notif: OsintNotification;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const timeStr = new Date(notif.at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div
      role="listitem"
      className={cn(
        "group relative flex gap-2.5 rounded-md border px-3 py-2 transition",
        SEVERITY_BORDER[notif.severity],
        !notif.read && "ring-1 ring-inset ring-white/5",
      )}
      onClick={() => onRead(notif.id)}
    >
      <KindIcon kind={notif.kind} severity={notif.severity} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-1">
          <span className={cn("text-[11px] font-semibold leading-snug", SEVERITY_TITLE[notif.severity])}>
            {notif.title}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDismiss(notif.id); }}
            className="ml-1 shrink-0 rounded p-0.5 opacity-0 transition hover:bg-white/10 group-hover:opacity-100"
            aria-label="Dismiss notification"
          >
            <X size={10} aria-hidden />
          </button>
        </div>
        <p className="mt-0.5 text-[10px] leading-snug text-muted/80">{notif.detail}</p>
        <div className="mt-1 flex items-center gap-2 text-[9px] text-muted/50">
          <span className="font-mono">{timeStr}</span>
          {!notif.read && (
            <span className="rounded-full bg-cyan-500/20 px-1.5 py-px text-cyan-300">new</span>
          )}
        </div>
      </div>
      <span
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", SEVERITY_DOT[notif.severity])}
        aria-hidden
      />
    </div>
  );
}

// ─── Notification Drawer ──────────────────────────────────────────────────────
function NotifDrawer({
  notifications,
  unreadCount,
  onRead,
  onMarkAll,
  onDismiss,
  onClear,
  onClose,
}: {
  notifications: OsintNotification[];
  unreadCount: number;
  onRead: (id: string) => void;
  onMarkAll: () => void;
  onDismiss: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const sorted = [...notifications].sort(sortBySeverity);

  return (
    <div className="absolute right-0 top-full z-50 mt-1.5 flex w-[360px] flex-col rounded-xl border border-white/12 bg-[#09090f]/95 shadow-2xl shadow-black/60 backdrop-blur-xl">
      {/* header */}
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Radio size={13} className="text-cyan-400" aria-hidden />
          <span className="text-[11px] font-bold uppercase tracking-widest text-foreground/80">
            Intel Feed
          </span>
          {unreadCount > 0 && (
            <span className="rounded-full bg-rose-500 px-1.5 py-px text-[9px] font-bold text-white">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={onMarkAll}
              title="Mark all read"
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted transition hover:bg-white/8 hover:text-foreground"
            >
              <CheckCheck size={10} aria-hidden />
              All read
            </button>
          )}
          {notifications.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              title="Clear all"
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted transition hover:bg-white/8 hover:text-rose-300"
            >
              <Trash2 size={10} aria-hidden />
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted transition hover:bg-white/8 hover:text-foreground"
            aria-label="Close"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>

      {/* stats strip */}
      <div className="flex gap-3 border-b border-white/8 px-3 py-1.5 text-[9px] text-muted/70">
        <span>
          <span className="text-foreground/60">{notifications.length}</span> total
        </span>
        <span>
          <span className="text-rose-400">{notifications.filter((n) => n.severity === "critical" || n.severity === "high").length}</span> threats
        </span>
        <span>
          <span className="text-cyan-400">{notifications.filter((n) => n.kind === "geo_ping").length}</span> geo
        </span>
        <span>
          <span className="text-amber-400">{notifications.filter((n) => n.kind === "signal_burst" || n.kind === "rate_spike").length}</span> bursts
        </span>
      </div>

      {/* list */}
      <div className="max-h-[440px] overflow-auto p-2" role="list" aria-label="OSINT notifications">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <BellOff size={20} className="text-muted/30" aria-hidden />
            <p className="text-[11px] text-muted/50">No notifications yet.</p>
            <p className="text-[10px] text-muted/35">
              Alerts appear automatically as signals, entities, and threats are detected.
            </p>
          </div>
        ) : (
          <div className="grid gap-1.5">
            {sorted.map((n) => (
              <NotifRow key={n.id} notif={n} onRead={onRead} onDismiss={onDismiss} />
            ))}
          </div>
        )}
      </div>

      {/* footer */}
      <div className="border-t border-white/8 px-3 py-1.5 text-[9px] text-muted/40">
        ARGUS Intel Feed · auto-generated from signal events · {new Date().toLocaleTimeString("en-GB")}
      </div>
    </div>
  );
}

// ─── Notification Bell (exported, placed in header) ───────────────────────────
export function NotificationBell() {
  const { notifications, unreadCount, markRead, markAllRead, dismiss, clearAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Flash animation on new notification
  const [flash, setFlash] = useState(false);
  const prevUnread = useRef(0);
  useEffect(() => {
    if (unreadCount > prevUnread.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 600);
      prevUnread.current = unreadCount;
      return () => clearTimeout(t);
    }
    prevUnread.current = unreadCount;
  }, [unreadCount]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Critical notification pulse
  const hasCritical = notifications.some((n) => !n.read && n.severity === "critical");
  const hasHigh = notifications.some((n) => !n.read && n.severity === "high");

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex size-8 items-center justify-center rounded-md border transition",
          open
            ? "border-white/20 bg-white/10 text-foreground"
            : "border-white/8 bg-transparent text-muted hover:border-white/15 hover:bg-white/5 hover:text-foreground",
          flash && "animate-pulse",
        )}
        aria-label={`Notifications${unreadCount > 0 ? ` · ${unreadCount} unread` : ""}`}
        aria-expanded={open}
      >
        {hasCritical ? (
          <ShieldAlert size={15} className="text-rose-400" aria-hidden />
        ) : hasHigh ? (
          <AlertTriangle size={15} className="text-orange-400" aria-hidden />
        ) : (
          <Bell size={15} aria-hidden />
        )}
        {unreadCount > 0 && (
          <span
            className={cn(
              "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-0.5 text-[8px] font-bold text-white",
              hasCritical ? "bg-rose-500" : hasHigh ? "bg-orange-500" : "bg-cyan-600",
            )}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
        {hasCritical && (
          <span className="absolute -right-1 -top-1 size-4 animate-ping rounded-full bg-rose-500/60" aria-hidden />
        )}
      </button>

      {open && (
        <NotifDrawer
          notifications={notifications}
          unreadCount={unreadCount}
          onRead={markRead}
          onMarkAll={markAllRead}
          onDismiss={dismiss}
          onClear={clearAll}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
