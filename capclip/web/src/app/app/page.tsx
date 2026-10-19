"use client";

import Link from "next/link";
import { ArrowRight, Clapperboard, Cpu, FolderKanban, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { ProjectCard } from "@/components/ProjectCard";
import { SourceForm } from "@/components/SourceForm";
import { Alert, Card, Empty, Skeleton, usePoll } from "@/components/ui";

export default function Dashboard() {
  const { data: projects, error, loading } = usePoll(() => api.projects(), [], (d) =>
    d?.some((p) => ["queued", "processing", "rendering"].includes(p.status)) ? 3000 : 15000);
  const { data: status } = usePoll(() => api.status(), [], () => null);

  const processing = projects?.filter((p) => ["queued", "processing", "rendering"].includes(p.status)) ?? [];
  const completed = projects?.filter((p) => p.status === "completed") ?? [];
  const recent = projects?.slice(0, 6) ?? [];
  const clipsReady = projects?.reduce((n, p) => n + p.clips_ready, 0) ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <section id="new" className="relative overflow-hidden rounded-3xl border border-line bg-panel p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-violet/20 blur-3xl" />
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">New project</h1>
        <p className="mt-1 text-sm text-muted">Paste a YouTube link or upload a video. CapClip analyses the whole thing and drafts every worthwhile Short.</p>
        <div className="mt-6"><SourceForm compact /></div>
      </section>

      {status && (!status.ai.configured || !status.transcription.configured || !status.ffmpeg.available) && (
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {!status.ffmpeg.available && <Alert tone="danger" title="FFmpeg not found">Rendering can&apos;t run until FFmpeg is installed on the server.</Alert>}
          {!status.transcription.configured && <Alert tone="danger" title="No transcription engine">{status.transcription.hint}</Alert>}
          {!status.ai.configured && (
            <Alert tone="info" title="Running with the local heuristic analyzer">
              {status.ai.hint} <Link href="/app/settings" className="text-violet-2 underline">System status</Link>
            </Alert>
          )}
        </div>
      )}

      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Projects", value: projects?.length, icon: FolderKanban },
          { label: "Processing now", value: processing.length, icon: Cpu },
          { label: "Completed", value: completed.length, icon: Sparkles },
          { label: "Clips ready", value: clipsReady, icon: Clapperboard },
        ].map((s) => (
          <Card key={s.label} className="p-4">
            <div className="flex items-center justify-between text-xs text-muted">{s.label}<s.icon className="h-4 w-4" /></div>
            <div className="mt-2 font-display text-2xl font-semibold">{loading && s.value == null ? <Skeleton className="h-7 w-10" /> : s.value ?? 0}</div>
          </Card>
        ))}
      </div>

      {error && <Alert tone="danger" className="mt-6" title="Can't load projects">{error}</Alert>}

      {processing.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 font-display text-lg font-semibold">Processing queue</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{processing.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
        </section>
      )}

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">Recent projects</h2>
          <Link href="/app/projects" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">All projects <ArrowRight className="h-4 w-4" /></Link>
        </div>
        {loading && !projects ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64" />)}</div>
        ) : recent.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{recent.map((p) => <ProjectCard key={p.id} p={p} />)}</div>
        ) : (
          <Empty icon={<FolderKanban className="h-6 w-6" />} title="No projects yet">Paste a link above to create your first batch of Shorts.</Empty>
        )}
      </section>
    </div>
  );
}
