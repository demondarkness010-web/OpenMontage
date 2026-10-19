"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Archive, Clapperboard, FolderKanban, LayoutDashboard, ListOrdered, Menu, Plus, Settings, X } from "lucide-react";
import { api, type Job } from "@/lib/api";
import { cx } from "@/lib/format";
import { Logo } from "@/components/ui";

const NAV = [
  { href: "/app", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/app/projects", label: "Projects", icon: FolderKanban },
  { href: "/app/library", label: "Clip library", icon: Clapperboard },
  { href: "/app/queue", label: "Processing queue", icon: ListOrdered },
  { href: "/app/exports", label: "Export history", icon: Archive },
  { href: "/app/settings", label: "Account & settings", icon: Settings },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Job[]>([]);
  const isEditor = path.startsWith("/app/clips/");

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        setActive(await api.jobs(true));
      } catch {
        /* backend offline: the page itself reports it */
      }
      t = setTimeout(poll, 4000);
    };
    poll();
    return () => clearTimeout(t);
  }, []);

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((n) => {
        const on = n.exact ? path === n.href : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={cx("flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition", on ? "bg-panel-3 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg")}>
            <n.icon className={cx("h-4 w-4", on && "text-violet-2")} />
            <span className="flex-1">{n.label}</span>
            {n.href === "/app/queue" && active.length > 0 && (
              <span className="rounded-full bg-violet/20 px-1.5 text-[11px] font-medium text-violet-2">{active.length}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={cx("fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-panel/60 p-4 lg:flex", isEditor && "lg:hidden")}>
        <Link href="/" className="mb-8 px-2 pt-1"><Logo /></Link>
        <Link href="/app#new" className="mb-6 inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-violet text-sm font-medium text-white transition hover:bg-violet-2">
          <Plus className="h-4 w-4" /> New project
        </Link>
        {nav}
        <div className="mt-auto rounded-xl border border-line bg-panel-2 p-3 text-xs text-muted">
          {active.length ? (
            <>
              <div className="mb-1 flex items-center gap-2 text-fg"><span className="h-2 w-2 rounded-full bg-violet animate-pulse-soft" /> {active.length} job{active.length > 1 ? "s" : ""} in progress</div>
              <div className="truncate">{active[0].project_title}: {active[0].message || active[0].stage}</div>
            </>
          ) : (
            <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-ok" /> Queue idle</div>
          )}
        </div>
      </aside>

      <div className={cx("flex min-w-0 flex-1 flex-col", !isEditor && "lg:pl-60")}>
        <header className={cx("sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-ink/80 px-4 backdrop-blur-xl", !isEditor && "lg:hidden")}>
          <div className="flex items-center gap-3">
            <button className="rounded-lg p-1.5 text-muted hover:bg-panel-3 hover:text-fg" onClick={() => setOpen(true)} aria-label="Open navigation"><Menu className="h-5 w-5" /></button>
            <Link href="/"><Logo className="text-sm" /></Link>
          </div>
          <Link href="/app#new" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-violet px-3 text-xs font-medium text-white"><Plus className="h-3.5 w-3.5" /> New</Link>
        </header>
        {open && (
          <div className="fixed inset-0 z-50 bg-black/60" onClick={() => setOpen(false)}>
            <div className="h-full w-72 border-r border-line bg-panel p-4" onClick={(e) => e.stopPropagation()}>
              <div className="mb-6 flex items-center justify-between"><Logo /><button onClick={() => setOpen(false)} aria-label="Close navigation" className="rounded-lg p-1 text-muted"><X className="h-5 w-5" /></button></div>
              {nav}
            </div>
          </div>
        )}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
