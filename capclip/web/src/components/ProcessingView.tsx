"use client";

import { Check, Loader2 } from "lucide-react";
import type { Project } from "@/lib/api";
import { cx, tc } from "@/lib/format";
import { Button, Card, Progress } from "./ui";

const STAGES = [
  ["queued", "Queued"],
  ["retrieving", "Retrieve source"],
  ["preparing", "Prepare media"],
  ["transcribing", "Transcribe speech"],
  ["audio", "Analyse audio"],
  ["scenes", "Detect scenes"],
  ["vision", "Analyse frames"],
  ["selecting", "Select moments"],
  ["drafting", "Draft clips"],
  ["rendering", "Render & check"],
] as const;

export function ProcessingView({ p, onCancel, cancelling }: { p: Project; onCancel: () => void; cancelling: boolean }) {
  const idx = Math.max(0, STAGES.findIndex(([id]) => id === p.stage));
  const renderJobs = p.jobs?.filter((j) => j.kind === "render" && (j.status === "running" || j.status === "queued")) ?? [];
  const running = p.jobs?.find((j) => j.status === "running");
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-violet-2"><Loader2 className="h-4 w-4 animate-spin" /> {STAGES[idx]?.[1] ?? p.stage}</div>
          <div className="mt-1 truncate text-sm text-muted">{p.message || "Working…"}</div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="font-display text-2xl font-semibold">{Math.round(p.progress * 100)}%</div>
            <div className="text-xs text-muted">{p.eta_seconds ? `about ${tc(p.eta_seconds)} left` : p.status === "queued" ? "waiting for a worker" : "estimating…"}</div>
          </div>
          <Button variant="danger" size="sm" onClick={onCancel} loading={cancelling}>Cancel</Button>
        </div>
      </div>
      <div className="p-5">
        <Progress value={p.progress} />
        <ol className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {STAGES.map(([id, label], i) => {
            const done = i < idx || p.status === "rendering" && id !== "rendering" && i < STAGES.length - 1;
            const current = i === idx;
            return (
              <li key={id} className={cx("flex items-center gap-2 rounded-xl border px-3 py-2 text-xs", current ? "border-violet/50 bg-violet/10 text-fg" : done ? "border-line text-muted" : "border-line/60 text-dim")}>
                <span className={cx("flex h-5 w-5 flex-none items-center justify-center rounded-full", done ? "bg-ok/15 text-ok" : current ? "bg-violet/20 text-violet-2" : "bg-panel-3")}>
                  {done ? <Check className="h-3 w-3" /> : current ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="text-[10px]">{i + 1}</span>}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
        {running && running.attempts > 1 && <p className="mt-4 text-xs text-warn">Attempt {running.attempts} of {running.max_attempts}. An earlier attempt failed and was retried automatically.</p>}
        {renderJobs.length > 0 && <p className="mt-4 text-xs text-muted">{renderJobs.length} clip render(s) remaining. Clips appear below as they finish.</p>}
      </div>
    </Card>
  );
}
