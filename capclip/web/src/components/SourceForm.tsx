"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowRight, CheckCircle2, FileVideo, Link2, Upload, X, Youtube } from "lucide-react";
import { api, ApiError, uploadSource, type ValidateResult } from "@/lib/api";
import { bytes, cx, dur } from "@/lib/format";
import { Alert, Button, Progress } from "./ui";

/**
 * Paste-a-link entry point (landing hero + dashboard). Validates the URL,
 * shows real public metadata, and is explicit about whether the server may
 * retrieve the video or needs the file uploaded.
 */
export function SourceForm({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"link" | "file">("link");
  const [url, setUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ValidateResult | null>(null);
  const [attest, setAttest] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function check(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setInfo(null);
    if (!url.trim()) return setError("Paste a YouTube video link to get started.");
    setChecking(true);
    try {
      setInfo(await api.validate(url.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check that link.");
    } finally {
      setChecking(false);
    }
  }

  async function createFromLink() {
    if (!info) return;
    setCreating(true);
    setError(null);
    try {
      const p = await api.createProject({ youtube_url: info.url, rights_attested: attest });
      router.push(`/app/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the project.");
      setCreating(false);
    }
  }

  async function createFromFile() {
    if (!file) return;
    setCreating(true);
    setError(null);
    abort.current = new AbortController();
    try {
      const p = await api.createProject({ title: file.name.replace(/\.[^.]+$/, "") });
      setUploadPct(0);
      await uploadSource(p.id, file, setUploadPct, abort.current.signal);
      router.push(`/app/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
      setCreating(false);
      setUploadPct(null);
    }
  }

  const meta = info?.metadata;
  const canRetrieve = info?.retrieval.youtube_download_enabled;

  return (
    <div className={cx("w-full text-left", compact ? "" : "max-w-2xl")}>
      <div className="mb-3 inline-flex rounded-xl border border-line bg-panel p-1 text-sm" role="tablist">
        {(["link", "file"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null); }}
            className={cx("inline-flex items-center gap-2 rounded-lg px-3 py-1.5 transition", mode === m ? "bg-panel-3 text-fg" : "text-muted hover:text-fg")}>
            {m === "link" ? <Link2 className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
            {m === "link" ? "YouTube link" : "Upload a file"}
          </button>
        ))}
      </div>

      {mode === "link" ? (
        <form onSubmit={check} className="group relative flex flex-col gap-2 rounded-2xl border border-line-2 bg-panel p-2 transition focus-within:border-violet/60 focus-within:shadow-[0_0_0_4px_rgba(139,92,246,.12)] sm:flex-row">
          <label htmlFor="yt-url" className="sr-only">YouTube video URL</label>
          <div className="flex flex-1 items-center gap-3 px-3">
            <Youtube className="h-5 w-5 flex-none text-muted" />
            <input
              id="yt-url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setInfo(null); }}
              placeholder="https://www.youtube.com/watch?v=…"
              className="h-12 w-full bg-transparent text-base outline-none placeholder:text-dim"
              autoComplete="off"
              inputMode="url"
            />
          </div>
          <Button type="submit" variant="primary" size="lg" loading={checking} className="sm:w-auto">
            Generate Shorts <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <div className="rounded-2xl border border-dashed border-line-2 bg-panel p-5">
          {!file ? (
            <label className="flex cursor-pointer flex-col items-center gap-2 py-6 text-center"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setFile(f); }}>
              <FileVideo className="h-8 w-8 text-violet-2" />
              <span className="font-medium">Drop a video file or click to browse</span>
              <span className="text-xs text-muted">MP4, MOV, MKV, WEBM — upload videos you own or are licensed to edit</span>
              <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <FileVideo className="h-6 w-6 flex-none text-violet-2" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{file.name}</div>
                  <div className="text-xs text-muted">{bytes(file.size)}</div>
                </div>
                {!creating && <button onClick={() => setFile(null)} className="rounded-lg p-1 text-muted hover:text-fg" aria-label="Remove file"><X className="h-4 w-4" /></button>}
              </div>
              {uploadPct != null && (
                <div>
                  <Progress value={uploadPct} />
                  <div className="mt-1.5 flex justify-between text-xs text-muted">
                    <span>Uploading securely…</span>
                    <span>{Math.round(uploadPct * 100)}%</span>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="primary" size="lg" loading={creating} onClick={createFromFile} className="flex-1">Generate Shorts <ArrowRight className="h-4 w-4" /></Button>
                {creating && <Button variant="ghost" size="lg" onClick={() => abort.current?.abort()}>Cancel</Button>}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}

      {info && meta && (
        <div className="mt-3 animate-fade-up overflow-hidden rounded-2xl border border-line bg-panel">
          <div className="flex gap-4 p-4">
            {meta.thumbnail && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={meta.thumbnail} alt="" className="h-20 w-36 flex-none rounded-lg object-cover" />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-ok"><CheckCircle2 className="h-3.5 w-3.5" /> Valid YouTube video</div>
              <div className="mt-1 line-clamp-2 font-medium">{meta.title ?? "Untitled video"}</div>
              <div className="mt-0.5 text-sm text-muted">{[meta.channel, meta.duration ? dur(meta.duration) : null].filter(Boolean).join(" · ")}</div>
              {meta.lookup_error && <div className="mt-1 text-xs text-warn">{meta.lookup_error}</div>}
            </div>
          </div>
          <div className="border-t border-line p-4">
            {canRetrieve ? (
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#8b5cf6]" />
                <span className="text-muted">I own this video or have permission to download and edit it. CapClip respects YouTube&apos;s terms and won&apos;t bypass private, age-gated or DRM-protected content.</span>
              </label>
            ) : (
              <Alert tone="info" title="This server can't download from YouTube">
                Downloading YouTube videos needs the creator&apos;s permission, so it is turned off here. CapClip will set up the project and ask you to upload the video file for this link.
              </Alert>
            )}
            <Button variant="primary" className="mt-4 w-full" loading={creating} disabled={!!canRetrieve && !attest} onClick={createFromLink}>
              {canRetrieve ? "Start processing" : "Continue — upload the file next"} <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
