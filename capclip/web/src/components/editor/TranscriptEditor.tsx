"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Eye, Flag, FlagOff, PenLine, Scissors, Undo2 } from "lucide-react";
import type { Edit, Plan, Word } from "@/lib/api";
import { cx, tc } from "@/lib/format";

/**
 * Word-level transcript editing. Click a word to select it, then cut or keep
 * it, fix its spelling, or move the clip start/end there. Pause markers show
 * where silence was tightened; click one to restore it.
 */
export function TranscriptEditor({ words, plan, edit, srcT, onToggleWord, onOverride, onToggleGap, onSetStart, onSetEnd, onSeek }: {
  words: Word[];
  plan: Plan;
  edit: Edit;
  srcT: number;
  onToggleWord: (i: number) => void;
  onOverride: (i: number, text: string) => void;
  onToggleGap: (id: number) => void;
  onSetStart: (w: Word) => void;
  onSetEnd: (w: Word) => void;
  onSeek: (t: number) => void;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const removed = useMemo(() => new Set(plan.removed), [plan.removed]);
  const auto = useMemo(() => new Set(plan.auto_removed), [plan.auto_removed]);
  const gapsAfter = useMemo(() => new Map(plan.gaps.map((g) => [g.after_word, g])), [plan.gaps]);
  const overrides = edit.word_overrides ?? {};
  const playingIdx = useMemo(() => words.find((w) => srcT >= w.s && srcT < w.e + 0.05)?.i, [words, srcT]);
  const selWord = words.find((w) => w.i === sel);

  useEffect(() => {
    if (playingIdx == null || !container.current) return;
    const el = container.current.querySelector(`[data-w="${playingIdx}"]`) as HTMLElement | null;
    if (el) {
      const c = container.current;
      const top = el.offsetTop - c.offsetTop;
      if (top < c.scrollTop + 20 || top > c.scrollTop + c.clientHeight - 40) c.scrollTo({ top: top - c.clientHeight / 3, behavior: "smooth" });
    }
  }, [playingIdx]);

  const commitEdit = () => {
    if (editing != null) onOverride(editing, draft.trim());
    setEditing(null);
  };

  return (
    <div>
      <div className="mb-2 flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-line bg-panel-2 p-1.5 text-xs">
        {selWord ? (
          <>
            <span className="px-2 font-medium text-fg">&ldquo;{overrides[selWord.i] ?? selWord.w}&rdquo; <span className="font-normal text-dim">{tc(selWord.s, true)}</span></span>
            {selWord.s >= edit.start - 0.2 && selWord.e <= edit.end + 0.5 && (
              <button onClick={() => onToggleWord(selWord.i)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-panel-3">
                {removed.has(selWord.i) ? <><Undo2 className="h-3.5 w-3.5" /> Keep word</> : <><Scissors className="h-3.5 w-3.5" /> Cut word</>}
              </button>
            )}
            <button onClick={() => { setEditing(selWord.i); setDraft(overrides[selWord.i] ?? selWord.w); }} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-panel-3"><PenLine className="h-3.5 w-3.5" /> Fix text</button>
            <button onClick={() => onSetStart(selWord)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-panel-3"><Flag className="h-3.5 w-3.5" /> Start here</button>
            <button onClick={() => onSetEnd(selWord)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-panel-3"><FlagOff className="h-3.5 w-3.5" /> End here</button>
            <button onClick={() => onSeek(selWord.s)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-panel-3"><Eye className="h-3.5 w-3.5" /> Seek</button>
          </>
        ) : (
          <span className="px-2 text-muted">Click a word to cut, correct or set the clip boundary. Double-click to fix spelling.</span>
        )}
      </div>
      <div ref={container} className="max-h-[340px] overflow-y-auto rounded-xl border border-line bg-panel p-4 text-[15px] leading-8">
        {words.map((w) => {
          const outside = w.e < edit.start - 0.05 || w.s > edit.end + 0.05;
          const isRemoved = !outside && removed.has(w.i);
          const isAuto = isRemoved && auto.has(w.i);
          const gap = gapsAfter.get(w.i);
          const text = overrides[w.i] ?? w.w;
          return (
            <span key={w.i}>
              {editing === w.i ? (
                <span className="inline-flex items-center gap-1">
                  <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitEdit}
                    onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(null); }}
                    className="h-7 rounded-md border border-violet/60 bg-panel-3 px-1.5 text-sm outline-none" style={{ width: `${Math.max(4, draft.length + 1)}ch` }} aria-label="Correct word" />
                  <CornerDownLeft className="h-3.5 w-3.5 text-dim" />
                </span>
              ) : (
                <span
                  data-w={w.i}
                  role="button"
                  tabIndex={-1}
                  onClick={() => setSel(w.i === sel ? null : w.i)}
                  onDoubleClick={() => { setEditing(w.i); setDraft(text); }}
                  title={w.p < 0.45 ? "Low transcription confidence. Check this word" : undefined}
                  className={cx(
                    "cursor-pointer rounded px-0.5 transition",
                    outside && "text-dim/70",
                    isRemoved && (isAuto ? "text-warn/70 line-through decoration-warn/70" : "text-danger/70 line-through decoration-danger"),
                    !outside && !isRemoved && "text-fg/90 hover:bg-panel-3",
                    overrides[w.i] != null && "underline decoration-violet decoration-2 underline-offset-4",
                    w.p < 0.45 && !outside && "bg-warn/10",
                    sel === w.i && "bg-violet/25 text-fg",
                    playingIdx === w.i && "bg-lime/25 text-fg",
                  )}
                >
                  {text}
                </span>
              )}
              {gap && !outside ? (
                <button onClick={() => onToggleGap(gap.id)} title={gap.cut ? "Restore this pause" : "Cut this pause"}
                  className={cx("mx-1 inline-flex h-5 items-center rounded px-1 align-middle font-mono text-[10px]", gap.cut ? "hatch text-danger" : "bg-lime/15 text-lime")}>
                  {gap.cut ? "✂" : "⏸"} {gap.length.toFixed(1)}s
                </button>
              ) : " "}
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-dim">
        <span><span className="text-danger line-through">word</span> cut by you</span>
        <span><span className="text-warn line-through">um</span> auto-removed filler/stutter</span>
        <span><span className="hatch rounded px-1 text-danger">✂ 0.8s</span> tightened pause</span>
        <span><span className="underline decoration-violet decoration-2">word</span> corrected</span>
        <span><span className="rounded bg-warn/10 px-1">word</span> low confidence</span>
      </div>
    </div>
  );
}
