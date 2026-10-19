import Link from "next/link";
import { Film, Upload, Youtube } from "lucide-react";
import type { Project } from "@/lib/api";
import { ago, dur, STAGE_LABEL } from "@/lib/format";
import { Progress, StatusBadge } from "./ui";

export function ProjectCard({ p }: { p: Project }) {
  const busy = ["queued", "processing", "rendering"].includes(p.status);
  const cover = p.cover_url ?? p.thumbnail;
  return (
    <Link href={`/app/projects/${p.id}`} className="group flex flex-col overflow-hidden rounded-2xl border border-line bg-panel transition hover:-translate-y-0.5 hover:border-line-2 hover:bg-panel-2">
      <div className="relative aspect-video overflow-hidden bg-panel-3">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="h-full w-full object-cover opacity-80 transition group-hover:opacity-100" />
        ) : (
          <div className="flex h-full items-center justify-center text-dim"><Film className="h-8 w-8" /></div>
        )}
        <div className="absolute left-2 top-2"><StatusBadge status={p.status} /></div>
        {p.source?.duration ? <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px]">{dur(p.source.duration)}</span> : null}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="line-clamp-2 font-medium leading-snug">{p.title}</div>
        <div className="flex items-center gap-2 text-xs text-muted">
          {p.source_kind === "youtube" ? <Youtube className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}
          <span>{ago(p.created_at)}</span>
          {p.clip_count > 0 && <span>· {p.clips_ready}/{p.clip_count} clips ready</span>}
        </div>
        {busy && (
          <div className="mt-auto pt-2">
            <Progress value={p.progress} />
            <div className="mt-1.5 truncate text-xs text-muted">{STAGE_LABEL[p.stage] ?? p.stage}{p.message ? ` · ${p.message}` : ""}</div>
          </div>
        )}
        {p.status === "awaiting_source" && <div className="mt-auto text-xs text-warn">Upload the video file to continue</div>}
        {p.status === "failed" && <div className="mt-auto line-clamp-2 text-xs text-danger">{p.message}</div>}
      </div>
    </Link>
  );
}
