"use client";

import { useRef, useState } from "react";
import { FileVideo, ShieldCheck, Upload } from "lucide-react";
import { ApiError, uploadSource, type Project } from "@/lib/api";
import { bytes, cx } from "@/lib/format";
import { Alert, Button, Card, Progress } from "./ui";

export function UploadPanel({ project, maxMb, onUploaded }: { project: Project; maxMb?: number; onUploaded: (p: Project) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const abort = useRef<AbortController | null>(null);

  async function start(f: File) {
    setFile(f);
    setError(null);
    if (maxMb && f.size > maxMb * 1024 * 1024) return setError(`That file is ${bytes(f.size)}; the limit is ${maxMb} MB.`);
    setPct(0);
    abort.current = new AbortController();
    try {
      onUploaded(await uploadSource(project.id, f, setPct, abort.current.signal));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
      setPct(null);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-warn/10 p-2.5 text-warn"><Upload className="h-5 w-5" /></div>
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">Upload the source video</h2>
          <p className="mt-1 text-sm text-muted">
            {project.source_kind === "youtube"
              ? "This server doesn't download from YouTube, since that needs the creator's permission. Upload your own copy of the video for this link and processing starts automatically."
              : "Add the video you want to turn into Shorts."}
          </p>
        </div>
      </div>
      {pct == null ? (
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) start(f); }}
          className={cx("mt-5 flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed p-10 text-center transition", drag ? "border-violet bg-violet/5" : "border-line-2 hover:border-violet/50")}
        >
          <FileVideo className="h-8 w-8 text-violet-2" />
          <span className="font-medium">Drop the video here or click to browse</span>
          <span className="text-xs text-muted">MP4, MOV, MKV, WEBM, AVI{maxMb ? ` · up to ${maxMb >= 1024 ? `${(maxMb / 1024).toFixed(0)} GB` : `${maxMb} MB`}` : ""}</span>
          <input type="file" accept="video/*,.mkv" className="sr-only" onChange={(e) => e.target.files?.[0] && start(e.target.files[0])} />
        </label>
      ) : (
        <div className="mt-5 rounded-2xl border border-line bg-panel-2 p-5">
          <div className="mb-3 flex items-center justify-between text-sm"><span className="truncate">{file?.name}</span><span className="text-muted">{Math.round(pct * 100)}%</span></div>
          <Progress value={pct} />
          <div className="mt-3 flex justify-between text-xs text-muted">
            <span>{bytes((file?.size ?? 0) * pct)} of {bytes(file?.size ?? 0)} · resumable</span>
            <button className="hover:text-fg" onClick={() => abort.current?.abort()}>Cancel</button>
          </div>
        </div>
      )}
      {error && <Alert tone="danger" className="mt-4">{error}</Alert>}
      <p className="mt-4 flex items-center gap-2 text-xs text-dim"><ShieldCheck className="h-3.5 w-3.5" /> Stored privately and served only through expiring signed links.</p>
    </Card>
  );
}
