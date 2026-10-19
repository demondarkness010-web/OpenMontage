"use client";

import { useEffect, useState } from "react";
import { Scissors, Sparkles, Wand2 } from "lucide-react";

const WORDS = ["Working", "longer", "hours", "does", "NOT", "make", "you", "more", "productive."];

/** Illustrative (demo) preview of the editor: captions, cut timeline, framing. */
export function EditorMock() {
  const [k, setK] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setK((x) => (x + 1) % (WORDS.length + 3)), 420);
    return () => clearInterval(t);
  }, []);
  const active = Math.min(k, WORDS.length - 1);
  const phrase = active < 3 ? WORDS.slice(0, 3) : active < 6 ? WORDS.slice(3, 6) : WORDS.slice(6);
  const offset = active < 3 ? 0 : active < 6 ? 3 : 6;

  return (
    <div className="relative mx-auto w-full max-w-5xl">
      <div className="absolute -inset-x-10 -top-10 -bottom-10 -z-10 rounded-[48px] bg-[radial-gradient(60%_60%_at_50%_40%,rgba(139,92,246,.25),transparent)]" />
      <div className="overflow-hidden rounded-3xl border border-line-2 bg-panel shadow-[0_40px_120px_-40px_rgba(0,0,0,.9)]">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-xs text-muted">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-line-2" /><span className="h-2.5 w-2.5 rounded-full bg-line-2" /><span className="h-2.5 w-2.5 rounded-full bg-line-2" />
            <span className="ml-3">Clip 03 · &ldquo;The productivity myth&rdquo;</span>
          </div>
          <span className="rounded-full border border-line-2 px-2 py-0.5 text-[10px] uppercase tracking-wider">Demo preview</span>
        </div>
        <div className="grid gap-0 md:grid-cols-[minmax(0,260px)_1fr]">
          <div className="flex items-center justify-center border-line bg-ink p-6 md:border-r">
            <div className="relative aspect-[9/16] w-44 overflow-hidden rounded-2xl border border-line-2 bg-gradient-to-b from-[#232045] via-[#1a1830] to-[#0f0e1a]">
              <div className="absolute left-1/2 top-[22%] h-24 w-20 -translate-x-1/2 rounded-[40%] bg-gradient-to-b from-[#e8c7a8] to-[#c99b78] opacity-90" />
              <div className="absolute left-1/2 top-[44%] h-32 w-32 -translate-x-1/2 rounded-t-[45%] bg-gradient-to-b from-[#3b3b58] to-[#26263a]" />
              <div className="absolute inset-x-3 top-[12%] rounded-md bg-[#101014] px-2 py-1 text-center text-[9px] font-bold text-white">The productivity myth</div>
              <div className="absolute inset-x-2 top-[66%] text-center font-display text-[15px] font-black uppercase leading-tight tracking-tight text-white [text-shadow:0_2px_0_#000,0_0_6px_#000]">
                {phrase.map((w, i) => (
                  <span key={i} className={i + offset === active ? "text-[#FFE11A]" : ""} style={{ display: "inline-block", transform: i + offset === active ? "scale(1.08)" : "none", transition: "transform .1s" }}>
                    {w}&nbsp;
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-violet/15 px-2.5 py-1 text-violet-2"><Sparkles className="h-3.5 w-3.5" /> Surprising fact</span>
              <span className="rounded-full bg-panel-3 px-2.5 py-1 text-muted">00:41 → 01:29 in source</span>
              <span className="rounded-full bg-panel-3 px-2.5 py-1 text-muted">47.2s final</span>
              <span className="rounded-full bg-lime/10 px-2.5 py-1 text-lime">6.1s of dead air removed</span>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-muted"><span>Timeline</span><span className="inline-flex items-center gap-1"><Scissors className="h-3.5 w-3.5" /> 9 smart cuts</span></div>
              <div className="relative h-12 overflow-hidden rounded-lg bg-panel-3">
                {[[0, 14], [16, 31], [33, 47], [50, 62], [64, 80], [82, 97]].map(([a, b], i) => (
                  <div key={i} className="absolute top-1.5 bottom-1.5 rounded-md bg-gradient-to-b from-violet/70 to-violet/40" style={{ left: `${a}%`, width: `${b - a}%` }} />
                ))}
                {[[14, 16], [31, 33], [47, 50], [62, 64], [80, 82]].map(([a, b], i) => (
                  <div key={i} className="hatch absolute top-0 bottom-0" style={{ left: `${a}%`, width: `${b - a}%` }} />
                ))}
                <div className="absolute top-0 bottom-0 w-0.5 bg-lime" style={{ left: `${(k / (WORDS.length + 3)) * 97}%`, transition: "left .4s linear" }} />
              </div>
            </div>
            <div className="rounded-xl border border-line bg-panel-2 p-3 text-sm leading-relaxed text-muted">
              Here&apos;s the truth nobody tells you about productivity. <span className="text-fg">Working longer hours does not make you more productive.</span> <span className="rounded bg-danger/15 px-1 text-danger line-through">um</span> In fact, after about fifty hours a week, output per hour drops…
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {["Bold Viral", "Clean Minimal", "Cinematic"].map((p, i) => (
                <div key={p} className={`rounded-lg border px-2 py-2 text-center ${i === 0 ? "border-violet/50 bg-violet/10 text-fg" : "border-line text-muted"}`}>{p}</div>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted"><Wand2 className="h-3.5 w-3.5 text-violet-2" /> Title: &ldquo;Why 50-hour weeks make you less productive&rdquo;</div>
          </div>
        </div>
      </div>
    </div>
  );
}
