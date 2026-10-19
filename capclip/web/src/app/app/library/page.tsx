"use client";

import { api } from "@/lib/api";
import { ClipBoard } from "@/components/ClipBoard";
import { Alert, Skeleton, usePoll } from "@/components/ui";

export default function Library() {
  const { data, error, refresh } = usePoll(() => api.clips(), [], (d) => (d?.some((c) => c.status === "queued" || c.status === "rendering") ? 3000 : null));
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Clip library</h1>
      <p className="mt-1 text-sm text-muted">Every Short across all your projects.</p>
      {error && <Alert tone="danger" className="mt-6">{error}</Alert>}
      <div className="mt-6">
        {!data ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="aspect-[9/16]" />)}</div>
        ) : (
          <ClipBoard clips={data} onChanged={refresh} showProject />
        )}
      </div>
    </div>
  );
}
