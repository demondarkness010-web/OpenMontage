"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { cx } from "@/lib/format";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-display font-semibold tracking-tight", className)}>
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
        <rect x="3" y="3" width="26" height="26" rx="8" fill="#8b5cf6" />
        <rect x="11" y="7" width="10" height="18" rx="3" fill="#0a0a0d" />
        <path d="M14.5 12.5v7l5-3.5z" fill="#c6ff3d" />
      </svg>
      <span>
        Cap<span className="text-violet-2">Clip</span>
      </span>
    </span>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "lime";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-violet text-white hover:bg-violet-2 shadow-[0_8px_30px_-12px_rgba(139,92,246,.8)]",
  lime: "bg-lime text-ink hover:brightness-95",
  secondary: "bg-panel-3 text-fg border border-line-2 hover:bg-line hover:border-line-2",
  ghost: "text-muted hover:text-fg hover:bg-panel-3",
  danger: "bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition active:scale-[.98] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-sm" : size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm",
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = "secondary", size = "md", className, children }: { href: string; variant?: Variant; size?: "sm" | "md" | "lg"; className?: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition active:scale-[.98]",
        size === "sm" ? "h-8 px-3 text-sm" : size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm",
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-2xl border border-line bg-panel", className)}>{children}</div>;
}

const BADGE: Record<string, string> = {
  neutral: "bg-panel-3 text-muted border-line-2",
  violet: "bg-violet/15 text-violet-2 border-violet/30",
  lime: "bg-lime/10 text-lime border-lime/30",
  ok: "bg-ok/10 text-ok border-ok/30",
  warn: "bg-warn/10 text-warn border-warn/30",
  danger: "bg-danger/10 text-danger border-danger/30",
};

export function Badge({ tone = "neutral", children, className, pulse }: { tone?: keyof typeof BADGE; children: ReactNode; className?: string; pulse?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", BADGE[tone], className)}>
      {pulse && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-soft" />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [keyof typeof BADGE, string, boolean?]> = {
    awaiting_source: ["warn", "Needs source"],
    draft: ["neutral", "Draft"],
    queued: ["neutral", "Queued", true],
    processing: ["violet", "Processing", true],
    running: ["violet", "Running", true],
    rendering: ["violet", "Rendering", true],
    building: ["violet", "Building", true],
    completed: ["ok", "Completed"],
    succeeded: ["ok", "Done"],
    ready: ["ok", "Ready"],
    failed: ["danger", "Failed"],
    cancelled: ["neutral", "Cancelled"],
  };
  const [tone, label, pulse] = map[status] ?? ["neutral", status];
  return <Badge tone={tone} pulse={pulse}>{label}</Badge>;
}

export function Progress({ value, className, tone = "violet" }: { value: number; className?: string; tone?: "violet" | "lime" }) {
  return (
    <div className={cx("h-1.5 w-full overflow-hidden rounded-full bg-panel-3", className)} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width] duration-700 ease-out", tone === "lime" ? "bg-lime" : "bg-gradient-to-r from-violet to-violet-2")} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton rounded-xl", className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-2 px-6 py-16 text-center">
      {icon && <div className="mb-4 rounded-2xl bg-panel-3 p-3 text-muted">{icon}</div>}
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      {children && <div className="mt-2 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Alert({ tone = "info", title, children, className }: { tone?: "info" | "warn" | "danger" | "ok"; title?: string; children?: ReactNode; className?: string }) {
  const Icon = tone === "danger" ? XCircle : tone === "warn" ? AlertTriangle : tone === "ok" ? CheckCircle2 : Info;
  const styles = {
    info: "border-violet/30 bg-violet/5 text-violet-2",
    warn: "border-warn/30 bg-warn/5 text-warn",
    danger: "border-danger/30 bg-danger/5 text-danger",
    ok: "border-ok/30 bg-ok/5 text-ok",
  }[tone];
  return (
    <div className={cx("flex gap-3 rounded-xl border p-3.5 text-sm", styles, className)} role={tone === "danger" ? "alert" : "status"}>
      <Icon className="mt-0.5 h-4 w-4 flex-none" />
      <div className="min-w-0 text-fg/90">
        {title && <div className="font-medium text-fg">{title}</div>}
        {children && <div className={cx(title && "mt-0.5", "text-muted")}>{children}</div>}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 h-6 w-11 flex-none rounded-full transition", checked ? "bg-violet" : "bg-line-2")}
      >
        <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", checked ? "left-[22px]" : "left-0.5")} />
      </button>
    </label>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal aria-label={title} className={cx("w-full animate-fade-up rounded-2xl border border-line bg-panel p-6 shadow-2xl outline-none", wide ? "max-w-3xl" : "max-w-md")}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-panel-3 hover:text-fg" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// --- Toasts -----------------------------------------------------------------

type Toast = { id: number; tone: "ok" | "danger" | "info"; text: string };
const ToastCtx = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx("pointer-events-auto flex max-w-sm animate-fade-up items-start gap-2 rounded-xl border bg-panel-2 px-4 py-3 text-sm shadow-xl",
            t.tone === "danger" ? "border-danger/40" : t.tone === "ok" ? "border-ok/40" : "border-line-2")}>
            {t.tone === "danger" ? <XCircle className="mt-0.5 h-4 w-4 flex-none text-danger" /> : t.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-ok" /> : <Info className="mt-0.5 h-4 w-4 flex-none text-violet-2" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// --- Polling ----------------------------------------------------------------

export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs: (data: T | undefined) => number | null) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const tick = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++tick.current;
    try {
      const d = await fnRef.current();
      if (my === tick.current) {
        setData(d);
        setError(null);
      }
      return d;
    } catch (e) {
      if (my === tick.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (my === tick.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    const loop = async () => {
      const d = await refresh();
      if (stopped) return;
      // A failed request (e.g. the API restarting) retries with backoff
      // instead of leaving the page stuck on its last state.
      failures = d === undefined ? failures + 1 : 0;
      const ms = failures ? Math.min(15000, 2000 * 2 ** (failures - 1)) : intervalRef.current(d as T | undefined);
      if (ms) timer = setTimeout(loop, document.hidden ? Math.max(ms, 5000) : ms);
    };
    setLoading(true);
    loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, setData, error, loading, refresh };
}
