"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, ArrowLeft, Check, ExternalLink, Pencil, RotateCcw, Trash2, Upload, Youtube } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { dur, STAGE_LABEL, tc } from "@/lib/format";
import { ClipBoard } from "@/components/ClipBoard";
import { ProcessingView } from "@/components/ProcessingView";
import { UploadPanel } from "@/components/UploadPanel";
import { Alert, Button, Card, Modal, Skeleton, StatusBadge, usePoll, useToast } from "@/components/ui";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data: p, setData, error, refresh } = usePoll(() => api.project(id), [id], (d) =>
    d && ["queued", "processing", "rendering"].includes(d.status) ? 2000 : d?.clips?.some((c) => c.status === "queued" || c.status === "rendering") ? 2500 : null);
  const { data: status } = usePoll(() => api.status(), [], () => null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  async function act(name: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(name);
    try {
      await fn();
      if (ok) toast("ok", ok);
      await refresh();
    } catch (e) {
      toast("danger", e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  if (error && !p) {
    return <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6"><Alert tone="danger" title="Couldn't load this project">{error}</Alert></div>;
  }
  if (!p) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[9/16]" />)}</div>
      </div>
    );
  }

  const processing = p.status === "queued" || p.status === "processing";
  const src = p.source;
  const analysis = src?.analysis ?? {};
  const clips = p.clips ?? [];
  const ready = clips.filter((c) => c.status === "ready").length;
  const failed = clips.filter((c) => c.status === "failed").length;
  const showUpload = p.status === "awaiting_source" || ((p.status === "failed" || p.status === "cancelled") && !src?.has_file && p.source_kind === "upload");
  const ytNeedsAttest = p.status === "awaiting_source" && p.source_kind === "youtube" && status?.retrieval.youtube_download_enabled && !src?.rights_attested;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Link href="/app/projects" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> Projects</Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {editingTitle != null ? (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); act("title", async () => setData(await api.renameProject(p.id, editingTitle))); setEditingTitle(null); }}>
              <input autoFocus value={editingTitle} onChange={(e) => setEditingTitle(e.target.value)} aria-label="Project title"
                className="h-10 w-full max-w-xl rounded-xl border border-line-2 bg-panel px-3 font-display text-xl outline-none focus:border-violet/60" />
              <Button type="submit" variant="primary"><Check className="h-4 w-4" /></Button>
            </form>
          ) : (
            <h1 className="group flex items-center gap-2 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              <span className="truncate">{p.title}</span>
              <button onClick={() => setEditingTitle(p.title)} className="rounded-lg p-1 text-dim opacity-0 transition hover:text-fg group-hover:opacity-100" aria-label="Rename project"><Pencil className="h-4 w-4" /></button>
            </h1>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <StatusBadge status={p.status} />
            {p.youtube_url && <a href={p.youtube_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg"><Youtube className="h-4 w-4" /> YouTube <ExternalLink className="h-3 w-3" /></a>}
            {src?.filename && <span className="inline-flex items-center gap-1"><Upload className="h-3.5 w-3.5" /> {src.filename}</span>}
            {src?.duration ? <span>{dur(src.duration)}</span> : null}
            {src?.width ? <span>{src.width}×{src.height}{src.fps ? ` · ${Math.round(src.fps)} fps` : ""}</span> : null}
          </div>
        </div>
        <div className="flex gap-2">
          {(p.status === "failed" || p.status === "cancelled") && src?.has_file && (
            <Button variant="primary" loading={busy === "retry"} onClick={() => act("retry", () => api.startProject(p.id), "Processing restarted")}><RotateCcw className="h-4 w-4" /> Retry</Button>
          )}
          {(p.status === "completed" || p.status === "rendering") && src?.has_file && (
            <Button loading={busy === "retry"} onClick={() => act("retry", () => api.startProject(p.id), "Re-analysing. Cached transcript and frames are reused")}><RotateCcw className="h-4 w-4" /> Re-analyse</Button>
          )}
          <Button variant="ghost" onClick={() => setConfirmDelete(true)} aria-label="Delete project"><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        {ytNeedsAttest && (
          <Card className="p-5">
            <h2 className="font-medium">Confirm your rights to this video</h2>
            <p className="mt-1 text-sm text-muted">Before CapClip downloads it from YouTube, confirm you own this video or are licensed to download and edit it.</p>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" loading={busy === "attest"} onClick={() => act("attest", async () => { await api.attest(p.id); await api.startProject(p.id); }, "Processing started")}>I have the rights, start processing</Button>
            </div>
          </Card>
        )}
        {showUpload && <UploadPanel project={p} maxMb={status?.limits.max_upload_mb} onUploaded={(np) => { setData(np); toast("ok", "Upload complete. Processing started"); }} />}

        {processing && <ProcessingView p={p} cancelling={busy === "cancel"} onCancel={() => act("cancel", () => api.cancelProject(p.id), "Cancellation requested")} />}

        {p.status === "failed" && (
          <Alert tone="danger" title={`Processing failed at "${STAGE_LABEL[p.stage] ?? p.stage}"`}>
            {p.message}
            {p.error && p.error !== p.message && <details className="mt-2"><summary className="cursor-pointer text-xs">Technical details</summary><pre className="mt-2 whitespace-pre-wrap text-xs">{p.error}</pre></details>}
          </Alert>
        )}
        {p.status === "cancelled" && <Alert tone="warn" title="Processing was cancelled">{src?.has_file ? "Choose Retry to start again. Completed steps are reused." : "Upload the file to start again."}</Alert>}

        {(p.status === "rendering" || p.status === "completed" || clips.length > 0) && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {[
                ["Source duration", src?.duration ? tc(src.duration) : "-"],
                ["Clips generated", p.summary.clips_generated ?? clips.length],
                ["Ready", `${ready}${clips.length ? ` / ${clips.length}` : ""}`],
                ["Failed", failed],
                ["Analyzer", analysis.analyzer === "anthropic" ? "Claude (multimodal)" : analysis.analyzer === "heuristic" ? "Local heuristic" : "-"],
                ["Transcriber", analysis.transcriber === "local" ? "Whisper (local)" : analysis.transcriber === "openai" ? "Whisper (cloud)" : "-"],
              ].map(([k, v]) => (
                <Card key={k as string} className="p-4">
                  <div className="text-xs text-muted">{k}</div>
                  <div className="mt-1 truncate font-display text-lg font-semibold">{v}</div>
                </Card>
              ))}
            </div>
            {analysis.words != null && (
              <p className="text-xs text-dim">
                Analysed {analysis.words?.toLocaleString()} words, {analysis.scenes ?? 0} scene changes and {analysis.frames_sampled?.toLocaleString()} sampled frames ({analysis.sample_fps} fps across the full video){analysis.language ? ` · language: ${analysis.language}` : ""}.
              </p>
            )}
            {p.warnings.length > 0 && (
              <div className="space-y-2">
                {p.warnings.map((w, i) => (
                  <div key={i} className="flex gap-2.5 rounded-xl border border-warn/20 bg-warn/5 px-3.5 py-2.5 text-sm text-muted">
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-warn" />{w}
                  </div>
                ))}
              </div>
            )}
            {p.status === "completed" && clips.length === 0 && (
              <Alert tone="warn" title="No clips met the quality bar">
                CapClip didn&apos;t find a standalone 30–60 second moment it could stand behind, so it didn&apos;t pad the output with filler. See the notes above.
              </Alert>
            )}
            <ClipBoard clips={clips} onChanged={refresh} />
          </>
        )}
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete project?">
        <p className="text-sm text-muted">This permanently deletes the project, its source file, transcript and every rendered clip. This can&apos;t be undone.</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" loading={busy === "delete"} onClick={() => act("delete", async () => { await api.deleteProject(p.id); router.push("/app/projects"); }, "Project deleted")}>Delete project</Button>
        </div>
      </Modal>
    </div>
  );
}
