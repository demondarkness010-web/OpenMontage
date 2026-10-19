"use client";

import Link from "next/link";
import { Archive, Download } from "lucide-react";
import { api } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import { Alert, Card, Empty, Skeleton, StatusBadge, usePoll } from "@/components/ui";

export default function Exports() {
  const { data, error } = usePoll(() => api.exports(), [], (d) => (d?.some((e) => e.status === "queued" || e.status === "building") ? 2000 : null));
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Export history</h1>
      <p className="mt-1 text-sm text-muted">ZIP archives of finished clips, with captions and a metadata sheet. Archives are kept for 7 days. Single MP4s can be downloaded from any clip card at any time.</p>
      {error && <Alert tone="danger" className="mt-6">{error}</Alert>}
      <div className="mt-6">
        {!data ? <Skeleton className="h-48" /> : data.length === 0 ? (
          <Empty icon={<Archive className="h-6 w-6" />} title="No exports yet">Select clips on a project page and choose Export.</Empty>
        ) : (
          <Card className="divide-y divide-line">
            {data.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <Archive className="h-5 w-5 flex-none text-violet-2" />
                <div className="min-w-0 flex-1">
                  <Link href={`/app/projects/${e.project_id}`} className="block truncate font-medium hover:underline">{e.project_title ?? "Deleted project"}</Link>
                  <div className="text-xs text-muted">{e.clip_count} clip(s){e.include_srt ? " · with SRT" : ""} · {ago(e.created_at)}{e.size_bytes ? ` · ${bytes(e.size_bytes)}` : ""}</div>
                  {e.error && <div className="mt-1 text-xs text-danger">{e.error}</div>}
                </div>
                <StatusBadge status={e.status} />
                {e.download_url && <a href={e.download_url} className="inline-flex h-9 items-center gap-2 rounded-xl bg-lime px-3 text-sm font-medium text-ink"><Download className="h-4 w-4" /> Download</a>}
              </div>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
