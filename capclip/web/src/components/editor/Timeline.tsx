"use client";

import { useCallback, useRef, useState } from "react";
import type { Plan, Word } from "@/lib/api";
import { tc } from "@/lib/format";

/**
 * Source-time timeline around the clip: drag the handles to move the start/end
 * (snapped to word boundaries), see kept segments and the cuts between them,
 * click to seek, click a cut marker to restore that pause.
 */
export function Timeline({ words, plan, start, end, srcT, sourceDuration, onRange, onSeek, onToggleGap, restoredGaps }: {
  words: Word[];
  plan: Plan;
  start: number;
  end: number;
  srcT: number;
  sourceDuration: number;
  onRange: (start: number, end: number, commit: boolean) => void;
  onSeek: (t: number) => void;
  onToggleGap: (id: number) => void;
  restoredGaps: number[];
}) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<null | "start" | "end">(null);
  const viewStart = Math.max(0, Math.min(start, words[0]?.s ?? start) - 2);
  const viewEnd = Math.min(sourceDuration || end + 30, Math.max(end, words[words.length - 1]?.e ?? end) + 2);
  const span = Math.max(1, viewEnd - viewStart);
  const pct = (t: number) => `${((t - viewStart) / span) * 100}%`;

  const timeAt = useCallback((clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return viewStart + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  }, [viewStart, span]);

  const snap = (t: number, which: "start" | "end") => {
    if (!words.length) return t;
    let best = which === "start" ? words[0].s : words[words.length - 1].e;
    let bd = Infinity;
    for (const w of words) {
      const edge = which === "start" ? w.s : w.e;
      const d = Math.abs(edge - t);
      if (d < bd) { bd = d; best = edge; }
    }
    return which === "start" ? Math.max(0, best - 0.12) : best + 0.05;
  };

  const onPointerDown = (which: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(which);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const t = snap(timeAt(e.clientX), drag);
    if (drag === "start" && t < end - 5) onRange(t, end, false);
    if (drag === "end" && t > start + 5) onRange(start, t, false);
  };
  const onPointerUp = () => {
    if (drag) onRange(start, end, true);
    setDrag(null);
  };

  const onKey = (which: "start" | "end") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.1;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const d = e.key === "ArrowLeft" ? -step : step;
    if (which === "start") onRange(Math.max(0, Math.min(end - 5, start + d)), end, true);
    else onRange(start, Math.max(start + 5, Math.min(sourceDuration, end + d)), true);
  };

  const ticks = Array.from({ length: Math.floor(span / 5) + 1 }, (_, k) => Math.ceil(viewStart / 5) * 5 + k * 5).filter((t) => t <= viewEnd);

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>Source {tc(start, true)} → {tc(end, true)}</span>
        <span>{plan.gaps.filter((g) => g.cut).length} cuts · {(plan.source_duration - plan.duration * plan.speed).toFixed(1)}s removed</span>
      </div>
      <div ref={track} className="relative h-16 cursor-pointer rounded-xl bg-panel-3" onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onClick={(e) => { if (!drag) onSeek(timeAt(e.clientX)); }} role="presentation">
        {/* word density */}
        {words.map((w) => (
          <div key={w.i} className="absolute bottom-1 h-2 rounded-sm bg-white/10" style={{ left: pct(w.s), width: `max(1px, ${((w.e - w.s) / span) * 100}%)` }} />
        ))}
        {/* outside-range shade */}
        <div className="absolute inset-y-0 left-0 rounded-l-xl bg-black/50" style={{ width: pct(start) }} />
        <div className="absolute inset-y-0 right-0 rounded-r-xl bg-black/50" style={{ left: pct(end) }} />
        {/* kept segments */}
        {plan.segments.map((s, k) => (
          <div key={k} className="absolute top-2 h-8 rounded-md bg-gradient-to-b from-violet/80 to-violet/45" style={{ left: pct(s.start), width: `${((s.end - s.start) / span) * 100}%` }} />
        ))}
        {/* gaps */}
        {plan.gaps.map((g) => (
          <button key={g.id} title={`${g.cut ? "Cut" : "Kept"} ${g.reason} (${g.length.toFixed(2)}s). Click to ${g.cut ? "restore" : "cut"}`}
            onClick={(e) => { e.stopPropagation(); onToggleGap(g.id); }}
            className={`absolute top-1 h-10 rounded-sm ${g.cut ? "hatch" : restoredGaps.includes(g.id) ? "bg-lime/30" : "bg-white/5"}`}
            style={{ left: pct(g.start), width: `max(3px, ${((g.end - g.start) / span) * 100}%)` }} aria-label={`Toggle ${g.length.toFixed(1)} second ${g.reason}`} />
        ))}
        {/* handles */}
        {(["start", "end"] as const).map((which) => (
          <div key={which} role="slider" tabIndex={0} aria-label={`Clip ${which}`} aria-valuenow={which === "start" ? start : end}
            onPointerDown={onPointerDown(which)} onKeyDown={onKey(which)}
            className="absolute -top-1 z-10 flex h-[72px] w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded-md bg-lime shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={{ left: pct(which === "start" ? start : end) }}>
            <span className="h-6 w-0.5 rounded bg-ink/60" />
          </div>
        ))}
        {/* playhead */}
        <div className="pointer-events-none absolute -top-1 bottom-[-4px] z-20 w-0.5 bg-white" style={{ left: pct(srcT) }} />
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-dim">
        {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>{tc(t)}</span>)}
      </div>
    </div>
  );
}
