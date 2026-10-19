"use client";

import Link from "next/link";
import { useState } from "react";
import { ListOrdered } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { ago, cx } from "@/lib/format";
import { Alert, Button, Card, Empty, Progress, Skeleton, StatusBadge, usePoll, useToast } from "@/components/ui";

const KIND = { analyze: "Analysis", render: "Render", export: "Export" } as const;

export default function Queue() {
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const { data, error, refresh } = usePoll(() => api.jobs(false), [], (d) => (d?.some((j) => j.status === "queued" || j.status === "running") ? 2000 : 8000));
  const jobs = (data ?? []).filter((j) => showAll || ["queued", "running", "failed"].includes(j.status));
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Processing queue</h1>
          <p className="mt-1 text-sm text-muted">Background jobs for analysis, rendering and exports. Failed steps are retried automatically with backoff.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="h-4 w-4 accent-[#8b5cf6]" /> Show finished jobs</label>
      </div>
      {error && <Alert tone="danger" className="mt-6">{error}</Alert>}
      <div className="mt-6">
        {!data ? <Skeleton className="h-60" /> : jobs.length === 0 ? (
          <Empty icon={<ListOrdered className="h-6 w-6" />} title="Queue is empty">Nothing is processing right now.</Empty>
        ) : (
          <Card className="divide-y divide-line">
            {jobs.map((j) => (
              <div key={j.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-dim">{KIND[j.kind]}</span>
                    <StatusBadge status={j.status} />
                    {j.attempts > 1 && <span className="text-xs text-warn">attempt {j.attempts}/{j.max_attempts}</span>}
                  </div>
                  <Link href={j.clip_id && j.kind === "render" ? `/app/clips/${j.clip_id}` : `/app/projects/${j.project_id}`} className="mt-1 block truncate font-medium hover:underline">
                    {j.project_title}{j.clip_title ? ` · ${j.clip_title}` : ""}
                  </Link>
                  <div className={cx("mt-0.5 truncate text-xs", j.status === "failed" ? "text-danger" : "text-muted")}>{j.status === "failed" ? j.error ?? j.message : j.message} · {ago(j.created_at)}</div>
                  {j.status === "running" && <Progress value={j.progress} className="mt-2 max-w-md" />}
                </div>
                {(j.status === "queued" || j.status === "running") && (
                  <Button size="sm" variant="danger" disabled={j.cancel_requested} onClick={async () => {
                    try { await api.cancelJob(j.id); toast("ok", "Cancellation requested"); refresh(); } catch (e) { toast("danger", e instanceof ApiError ? e.message : "Couldn't cancel"); }
                  }}>{j.cancel_requested ? "Cancelling…" : "Cancel"}</Button>
                )}
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
