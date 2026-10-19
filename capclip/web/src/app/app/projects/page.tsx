"use client";

import { useState } from "react";
import { FolderKanban } from "lucide-react";
import { api } from "@/lib/api";
import { cx } from "@/lib/format";
import { ProjectCard } from "@/components/ProjectCard";
import { Alert, Empty, LinkButton, Skeleton, usePoll } from "@/components/ui";

const TABS = [
  { id: "all", label: "All" },
  { id: "active", label: "In progress", match: ["queued", "processing", "rendering", "awaiting_source"] },
  { id: "completed", label: "Completed", match: ["completed"] },
  { id: "failed", label: "Failed or cancelled", match: ["failed", "cancelled"] },
];

export default function Projects() {
  const [tab, setTab] = useState("all");
  const { data, error, loading } = usePoll(() => api.projects(), [], (d) => (d?.some((p) => ["queued", "processing", "rendering"].includes(p.status)) ? 3000 : 20000));
  const t = TABS.find((x) => x.id === tab)!;
  const list = (data ?? []).filter((p) => !t.match || t.match.includes(p.status));
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted">Every source video you&apos;ve turned into Shorts.</p>
        </div>
        <LinkButton href="/app#new" variant="primary">New project</LinkButton>
      </div>
      <div className="mt-6 flex flex-wrap gap-2" role="tablist">
        {TABS.map((x) => {
          const n = (data ?? []).filter((p) => !x.match || x.match.includes(p.status)).length;
          return (
            <button key={x.id} role="tab" aria-selected={tab === x.id} onClick={() => setTab(x.id)}
              className={cx("rounded-full border px-3 py-1.5 text-sm transition", tab === x.id ? "border-violet/50 bg-violet/10 text-fg" : "border-line text-muted hover:text-fg")}>
              {x.label} <span className="text-dim">{n}</span>
            </button>
          );
        })}
      </div>
      {error && <Alert tone="danger" className="mt-6">{error}</Alert>}
      <div className="mt-6">
        {loading && !data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-64" />)}</div>
        ) : list.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{list.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
        ) : (
          <Empty icon={<FolderKanban className="h-6 w-6" />} title="Nothing here">No projects match this filter.</Empty>
        )}
      </div>
    </div>
  );
}
