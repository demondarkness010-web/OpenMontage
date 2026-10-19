"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { Clip } from "@/lib/api";
import { CATEGORY_LABEL, cx, tc } from "@/lib/format";
import { Badge, StatusBadge } from "./ui";

export function ClipCard({ clip, selected, onSelect, onRegenerate, onDelete, showProject }: {
  clip: Clip;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
  onRegenerate?: () => void;
  onDelete?: () => void;
  showProject?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  const busy = clip.status === "queued" || clip.status === "rendering";
  const scoreTone = clip.score >= 70 ? "lime" : clip.score >= 50 ? "violet" : "neutral";

  return (
    <article className={cx("group flex flex-col overflow-hidden rounded-2xl border bg-panel transition", selected ? "border-violet/60 ring-1 ring-violet/40" : "border-line hover:border-line-2")}>
      <div
        className="relative aspect-[9/16] overflow-hidden bg-panel-3"
        onMouseEnter={() => { setHover(true); video.current?.play().catch(() => {}); }}
        onMouseLeave={() => { setHover(false); if (video.current) { video.current.pause(); video.current.currentTime = 0; } }}
      >
        {clip.video_url ? (
          <video ref={video} src={clip.video_url} poster={clip.thumb_url ?? undefined} muted playsInline loop preload="none"
            className="h-full w-full object-cover" aria-label={`Preview of ${clip.title}`} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted">
            {busy ? <Loader2 className="h-6 w-6 animate-spin text-violet-2" /> : <AlertTriangle className="h-6 w-6 text-warn" />}
            {busy ? (clip.status === "queued" ? "Waiting to render" : "Rendering…") : clip.status === "draft" ? "Not rendered yet" : "Render failed"}
          </div>
        )}
        {onSelect && (
          <label className="absolute left-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg bg-black/60 backdrop-blur" title="Select for bulk export">
            <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} className="h-4 w-4 accent-[#8b5cf6]" aria-label={`Select ${clip.title}`} />
          </label>
        )}
        <div className="absolute right-2 top-2"><StatusBadge status={clip.status} /></div>
        <div className={cx("absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/85 to-transparent p-2.5 pt-8 text-[11px] text-white/90 transition", hover && "opacity-0")}>
          <span>{tc(clip.source_start)} – {tc(clip.source_end)}</span>
          <span className="rounded bg-black/60 px-1.5 py-0.5 font-medium">{clip.duration.toFixed(1)}s</span>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        {showProject && clip.project_title && <div className="truncate text-[11px] uppercase tracking-wide text-dim">{clip.project_title}</div>}
        <h3 className="line-clamp-2 text-sm font-medium leading-snug">{clip.title}</h3>
        {clip.hook && <p className="line-clamp-1 text-xs text-violet-2">Hook: {clip.hook}</p>}
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={scoreTone} className="!text-[11px]">{Math.round(clip.score)} potential</Badge>
          <Badge className="!text-[11px]">{CATEGORY_LABEL[clip.category] ?? clip.category}</Badge>
          <Badge className="!text-[11px]">{clip.caption_preset_label}</Badge>
        </div>
        <p className="line-clamp-3 text-xs leading-relaxed text-muted" title={clip.reason}>{clip.reason}</p>
        {clip.status === "failed" && clip.warnings[0] && <p className="line-clamp-2 text-xs text-danger">{clip.warnings[0]}</p>}
        {clip.needs_render && clip.status === "ready" && <p className="text-xs text-warn">Edited since last render</p>}
        <div className="mt-auto grid grid-cols-4 gap-1 pt-1">
          <a href={clip.download_url ?? undefined} aria-disabled={!clip.download_url} title="Download MP4"
            className={cx("flex h-8 items-center justify-center rounded-lg border border-line-2 text-muted transition hover:bg-panel-3 hover:text-fg", !clip.download_url && "pointer-events-none opacity-40")}>
            <Download className="h-4 w-4" /><span className="sr-only">Download</span>
          </a>
          <Link href={`/app/clips/${clip.id}`} title="Edit" className="flex h-8 items-center justify-center rounded-lg border border-line-2 text-muted transition hover:bg-panel-3 hover:text-fg">
            <Pencil className="h-4 w-4" /><span className="sr-only">Edit</span>
          </Link>
          <button onClick={onRegenerate} disabled={busy} title="Regenerate" className="flex h-8 items-center justify-center rounded-lg border border-line-2 text-muted transition hover:bg-panel-3 hover:text-fg disabled:opacity-40">
            <RefreshCw className="h-4 w-4" /><span className="sr-only">Regenerate</span>
          </button>
          <button onClick={onDelete} title="Delete" className="flex h-8 items-center justify-center rounded-lg border border-line-2 text-muted transition hover:border-danger/40 hover:bg-danger/10 hover:text-danger">
            <Trash2 className="h-4 w-4" /><span className="sr-only">Delete</span>
          </button>
        </div>
      </div>
    </article>
  );
}
