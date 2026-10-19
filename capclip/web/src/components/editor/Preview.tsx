"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import type { CaptionStyle, Edit, Plan, PlanWord } from "@/lib/api";
import { buildPhrases, displayText, lineBreak, outlineShadow } from "@/lib/captions";
import { cx, tc } from "@/lib/format";

export type PreviewMode = "edited" | "original" | "rendered";
export interface PreviewHandle { seekSource: (t: number) => void; seekOutput: (t: number) => void; play: () => void; pause: () => void }

const W = 1080;
const H = 1920;

function outToSrc(plan: Plan, t: number): number {
  let acc = 0;
  const x = t * plan.speed;
  for (const s of plan.segments) {
    const len = s.end - s.start;
    if (x <= acc + len) return s.start + (x - acc);
    acc += len;
  }
  const last = plan.segments[plan.segments.length - 1];
  return last ? last.end : 0;
}

function srcToOut(plan: Plan, t: number): number | null {
  let acc = 0;
  for (const s of plan.segments) {
    if (t >= s.start - 0.001 && t <= s.end + 0.001) return (acc + Math.max(0, t - s.start)) / plan.speed;
    acc += s.end - s.start;
  }
  return null;
}

/**
 * Live preview: draws the proxy video into a 9:16 canvas with the clip's
 * layout, skips cut ranges in real time and overlays styled captions, so
 * edits are visible instantly. "Rendered" shows the actual exported MP4.
 */
export const Preview = forwardRef<PreviewHandle, {
  proxyUrl: string | null;
  renderedUrl: string | null;
  mode: PreviewMode;
  plan: Plan;
  edit: Edit;
  style: CaptionStyle & { enabled: boolean };
  layout: string;
  clusters: number[];
  faceTrack: { t: number; faces: { x: number; y: number; w: number; h: number }[] }[];
  burnedBox?: number[] | null;
  burnedStrategy: string;
  emphasis: Set<number>;
  onTime?: (srcT: number, outT: number | null) => void;
}>(function Preview(props, ref) {
  const { proxyUrl, renderedUrl, mode, plan, edit, style, layout, clusters, faceTrack, burnedBox, burnedStrategy, emphasis, onTime } = props;
  const video = useRef<HTMLVideoElement>(null);
  const rendered = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [outT, setOutT] = useState(0);
  const [srcT, setSrcT] = useState(edit.start);
  const [scale, setScale] = useState(0.3);
  const camX = useRef<number | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Keep caption sizes proportional to the preview width.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const faceAt = useCallback((t: number) => {
    const track = propsRef.current.faceTrack;
    if (!track.length) return null;
    let lo = 0;
    let hi = track.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (track[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    for (let d = 0; d < 4; d++) {
      for (const k of [lo - d, lo + d]) {
        const f = track[k];
        if (f?.faces.length) return f.faces.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
      }
    }
    return null;
  }, []);

  const draw = useCallback(() => {
    const v = video.current;
    const c = canvas.current;
    if (!v || !c || v.readyState < 2) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const p = propsRef.current;
    const vw = v.videoWidth;
    let vh = v.videoHeight;
    if (!vw || !vh) return;
    if (p.mode === "original") {
      // Landscape-faithful view of the untouched source range.
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, c.width, c.height);
      const s = Math.min(c.width / vw, c.height / vh);
      ctx.drawImage(v, (c.width - vw * s) / 2, (c.height - vh * s) / 2, vw * s, vh * s);
      return;
    }
    const strategy = p.burnedStrategy;
    const bb = p.burnedBox;
    const cropBottom = strategy === "crop" && bb ? bb[1] : 1;
    vh = Math.round(vh * cropBottom);
    const zoom = Math.max(1, p.edit.framing.zoom || 1);
    const scaleK = c.width / W;
    const paintMask = (dx: number, dy: number, sx: number, sy: number) => {
      if (strategy !== "mask" || !bb) return;
      ctx.save();
      ctx.filter = "blur(14px)";
      ctx.drawImage(v, bb[0] * vw, bb[1] * v.videoHeight, bb[2] * vw, bb[3] * v.videoHeight, dx + bb[0] * vw * sx, dy + bb[1] * v.videoHeight * sy, bb[2] * vw * sx, bb[3] * v.videoHeight * sy);
      ctx.restore();
    };

    if (p.layout === "fill") {
      const ch = vh / zoom;
      const cw = Math.min(vw, (ch * 9) / 16);
      let target = p.edit.framing.subject_x;
      if (target == null) {
        const f = faceAt(v.currentTime);
        target = f ? f.x : camX.current ?? 0.5;
        // dead-zone smoothing similar to the renderer
        if (camX.current == null || Math.abs(target - camX.current) > 0.07) camX.current = camX.current == null ? target : camX.current + (target - camX.current) * 0.08;
        target = camX.current;
      }
      const sx = Math.min(vw - cw, Math.max(0, target * vw - cw / 2));
      const f = faceAt(v.currentTime);
      const fy = f ? f.y : 0.4;
      const sy = Math.min(vh - ch, Math.max(0, fy * vh - ch * 0.38));
      ctx.drawImage(v, sx, sy, cw, ch, 0, 0, c.width, c.height);
      if (strategy === "mask" && bb) {
        const k = c.width / cw;
        ctx.save();
        ctx.filter = "blur(14px)";
        ctx.drawImage(v, bb[0] * vw, bb[1] * v.videoHeight, bb[2] * vw, bb[3] * v.videoHeight, (bb[0] * vw - sx) * k, (bb[1] * v.videoHeight - sy) * k, bb[2] * vw * k, bb[3] * v.videoHeight * k);
        ctx.restore();
      }
    } else if (p.layout === "split" && p.clusters.length === 2) {
      const halfH = c.height / 2;
      const ch = (vh * 0.92) / zoom;
      const cw = Math.min(vw * 0.55, (ch * c.width) / halfH);
      const f = faceAt(v.currentTime);
      const sy = Math.max(0, Math.min(vh - ch, (f ? f.y : 0.4) * vh - ch * 0.4));
      p.clusters.forEach((cx_, k) => {
        const sx = Math.min(vw - cw, Math.max(0, cx_ * vw - cw / 2));
        ctx.drawImage(v, sx, sy, cw, ch, 0, k * halfH, c.width, halfH);
      });
      ctx.fillStyle = "rgba(0,0,0,.85)";
      ctx.fillRect(0, halfH - 3 * scaleK, c.width, 6 * scaleK);
    } else {
      // blur / fit
      ctx.save();
      ctx.filter = "blur(18px) brightness(0.92) saturate(1.1)";
      const cover = Math.max(c.width / vw, c.height / vh);
      ctx.drawImage(v, 0, 0, vw, vh, (c.width - vw * cover) / 2, (c.height - vh * cover) / 2, vw * cover, vh * cover);
      ctx.restore();
      const fit = Math.min(c.width / vw, c.height / vh) * zoom;
      const dw = vw * fit;
      const dh = vh * fit;
      const subj = p.edit.framing.subject_x ?? 0.5;
      const dx = dw > c.width ? Math.min(0, Math.max(c.width - dw, c.width / 2 - subj * dw)) : (c.width - dw) / 2;
      const dy = p.layout === "fit" ? (c.height - dh) / 2 : Math.max(0, Math.min(c.height - dh, c.height * 0.44 - dh / 2));
      ctx.drawImage(v, 0, 0, vw, vh, dx, dy, dw, dh);
      paintMask(dx, dy, fit, fit);
    }
  }, [faceAt, scale]);

  // Main loop: enforce cuts during playback and repaint.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const v = video.current;
      const p = propsRef.current;
      if (v && p.mode !== "rendered") {
        const t = v.currentTime;
        if (p.mode === "edited" && !v.paused) {
          const segs = p.plan.segments;
          const inSeg = segs.findIndex((s) => t >= s.start - 0.03 && t < s.end);
          if (inSeg === -1) {
            const next = segs.find((s) => s.start > t);
            if (next) v.currentTime = next.start;
            else { v.pause(); v.currentTime = segs[0]?.start ?? p.edit.start; }
          }
        } else if (p.mode === "original" && !v.paused && t >= p.edit.end) {
          v.pause();
          v.currentTime = p.edit.start;
        }
        const o = p.mode === "edited" ? srcToOut(p.plan, v.currentTime) : v.currentTime - p.edit.start;
        setSrcT(v.currentTime);
        if (o != null) setOutT(o);
        p.onTime?.(v.currentTime, o);
        draw();
      } else if (rendered.current && p.mode === "rendered") {
        setOutT(rendered.current.currentTime);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  useEffect(() => {
    const v = video.current;
    if (v) v.playbackRate = mode === "edited" ? plan.speed : 1;
  }, [plan.speed, mode]);

  useEffect(() => {
    const v = video.current;
    if (v) v.volume = Math.max(0, Math.min(1, 10 ** ((edit.volume_db || 0) / 20)));
  }, [edit.volume_db]);

  // Switching modes pauses and parks the playhead at the clip start.
  useEffect(() => {
    setPlaying(false);
    video.current?.pause();
    rendered.current?.pause();
    if (video.current && mode !== "rendered") video.current.currentTime = mode === "edited" ? plan.segments[0]?.start ?? edit.start : edit.start;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const active = mode === "rendered" ? rendered.current : video.current;
  const toggle = () => {
    const el = active;
    if (!el) return;
    if (el.paused) {
      if (mode === "edited" && el === video.current && srcToOut(plan, el.currentTime) == null) el.currentTime = plan.segments[0]?.start ?? edit.start;
      el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  useImperativeHandle(ref, () => ({
    seekSource: (t) => { if (video.current) video.current.currentTime = t; draw(); },
    seekOutput: (t) => {
      if (mode === "rendered" && rendered.current) rendered.current.currentTime = t;
      else if (video.current) video.current.currentTime = mode === "edited" ? outToSrc(plan, t) : edit.start + t;
    },
    play: () => { if (active?.paused) toggle(); },
    pause: () => { active?.pause(); setPlaying(false); },
  }));

  const total = mode === "edited" ? plan.duration : mode === "original" ? edit.end - edit.start : rendered.current?.duration || 0;

  // Caption overlay for the current output time.
  const phrases = useMemo(() => buildPhrases(plan.words, style), [plan.words, style]);
  const captionNode = useMemo(() => {
    if (mode !== "edited" || !style.enabled) return null;
    const idx = phrases.findIndex((ph, k) => {
      const next = phrases[k + 1];
      const end = Math.min(ph[ph.length - 1].e + 0.25, next ? next[0].s : Infinity);
      return outT >= ph[0].s && outT < end;
    });
    if (idx === -1) return null;
    const ph = phrases[idx];
    const tokens = ph.map((w) => displayText(w.w, style));
    const rows = lineBreak(tokens, style.max_chars_per_line, style.max_lines);
    const activeIdx = ph.reduce((acc, w: PlanWord, k) => (outT >= w.s ? k : acc), 0);
    const startedAgo = outT - ph[0].s;
    const pop = style.animation === "pop" && startedAgo < 0.11 / style.animation_speed;
    const fade = style.animation === "fade" ? Math.min(1, startedAgo / (0.16 / style.animation_speed)) : 1;
    const sh = [outlineShadow(style.outline, style.outline_color, scale), style.shadow ? `0 ${style.shadow * 2 * scale}px ${style.shadow * 3 * scale}px rgba(0,0,0,.6)` : ""].filter((x) => x && x !== "none").join(",") || "none";
    return (
      <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ top: `${style.position * 100}%`, transform: "translateY(-50%)", padding: `0 ${90 * scale}px` }}>
        <div style={{
          fontFamily: `"${style.font}", Arial, sans-serif`, fontSize: style.size * scale, fontWeight: style.bold ? 800 : 400, color: style.color,
          letterSpacing: style.letter_spacing * scale, lineHeight: 1.18, textAlign: "center", textShadow: style.box ? "none" : sh, opacity: fade,
          transform: pop ? "scale(.86)" : "scale(1)", transition: "transform .08s ease-out",
          background: style.box ? hexA(style.box_color) : undefined, padding: style.box ? `${8 * scale}px ${16 * scale}px` : undefined, borderRadius: style.box ? 10 * scale : undefined,
        }}>
          {rows.map((row, r) => (
            <div key={r}>
              {row.map((k, n) => {
                const isActive = k === activeIdx && style.highlight_mode !== "none";
                const isEm = emphasis.has(ph[k].i) && style.highlight_mode !== "none";
                const boxed = isActive && style.highlight_mode === "box";
                return (
                  <span key={k}>{n > 0 && " "}<span style={{
                    color: isActive ? style.highlight : isEm ? style.emphasis : undefined, display: "inline-block",
                    transform: isActive && style.highlight_mode === "color" ? "scale(1.08)" : undefined,
                    background: boxed ? style.box_color.slice(0, 7) : undefined, borderRadius: boxed ? 10 * scale : undefined,
                    padding: boxed ? `0 ${10 * scale}px` : undefined, textShadow: boxed ? "none" : undefined,
                  }}>{tokens[k]}</span></span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  }, [mode, style, phrases, outT, scale, emphasis]);

  const hookOn = mode === "edited" && edit.hook.show && edit.hook.text.trim() && outT < (edit.hook.duration || 3);

  return (
    <div className="flex flex-col items-center gap-3">
      <div ref={box} className={cx("relative overflow-hidden rounded-2xl border border-line-2 bg-black shadow-2xl", mode === "original" ? "aspect-video w-full max-w-[560px]" : "aspect-[9/16] w-full max-w-[330px]")}>
        {mode === "rendered" ? (
          renderedUrl ? (
            <video ref={rendered} src={renderedUrl} className="h-full w-full" playsInline muted={muted} onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted">No render yet. Choose Save &amp; render.</div>
          )
        ) : (
          <canvas ref={canvas} width={mode === "original" ? 960 : 540} height={mode === "original" ? 540 : 960} className="h-full w-full" onClick={toggle} />
        )}
        {captionNode}
        {hookOn && (
          <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ top: "20%", transform: "translateY(-50%)", padding: `0 ${90 * scale}px` }}>
            <div className="text-center font-bold text-white" style={{ fontFamily: `"${style.font}", Arial`, fontSize: Math.max(52, style.size * 0.82) * scale, background: "#101014", padding: `${10 * scale}px ${22 * scale}px`, borderRadius: 8 * scale, lineHeight: 1.15 }}>
              {edit.hook.text}
            </div>
          </div>
        )}
        {mode === "edited" && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[15%] border-t border-dashed border-white/10" title="Platform UI zone" />}
        {!proxyUrl && mode !== "rendered" && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">Preview unavailable</div>}
      </div>
      <video ref={video} src={proxyUrl ?? undefined} className="hidden" preload="auto" playsInline muted={muted} crossOrigin="anonymous"
        onLoadedData={() => { if (video.current) { video.current.currentTime = plan.segments[0]?.start ?? edit.start; } }}
        onSeeked={draw} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
      <div className="flex w-full max-w-[560px] items-center gap-3">
        <button onClick={toggle} className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-fg text-ink transition hover:scale-105" aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
        </button>
        <button onClick={() => { const el = mode === "rendered" ? rendered.current : video.current; if (el) { el.currentTime = mode === "edited" ? plan.segments[0]?.start ?? edit.start : mode === "original" ? edit.start : 0; } }}
          className="rounded-lg p-2 text-muted hover:bg-panel-3 hover:text-fg" aria-label="Back to start"><RotateCcw className="h-4 w-4" /></button>
        <input type="range" min={0} max={Math.max(0.1, total)} step={0.05} value={Math.min(outT, total)} aria-label="Scrub"
          onChange={(e) => { const t = Number(e.target.value); if (mode === "rendered" && rendered.current) rendered.current.currentTime = t; else if (video.current) video.current.currentTime = mode === "edited" ? outToSrc(plan, t) : edit.start + t; }}
          className="h-1 flex-1" />
        <span className="w-24 text-right font-mono text-xs tabular-nums text-muted">{tc(outT, true)} / {tc(total, true)}</span>
        <button onClick={() => setMuted((m) => !m)} className="rounded-lg p-2 text-muted hover:bg-panel-3 hover:text-fg" aria-label={muted ? "Unmute" : "Mute"}>
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      </div>
      {mode !== "rendered" && <div className="text-[11px] text-dim">Source {tc(srcT, true)} · live preview (the final render uses the full-resolution source)</div>}
    </div>
  );
});

function hexA(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 8) return `#${h}`;
  const a = parseInt(h.slice(6, 8), 16) / 255;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a.toFixed(2)})`;
}
