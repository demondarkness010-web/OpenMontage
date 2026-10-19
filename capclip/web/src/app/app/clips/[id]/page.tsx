"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Captions, CheckCircle2, ClipboardCopy, Crop, Download, Film, Gauge, Loader2, Redo2, RotateCcw, Save, ScanText, ShieldCheck, Sparkles, Undo2, Wand2, XCircle,
} from "lucide-react";
import { api, ApiError, type ClipDetail, type Edit, type Plan, type Publish, type SystemStatus, type Word } from "@/lib/api";
import { resolveStyle } from "@/lib/captions";
import { CATEGORY_LABEL, cx, tc } from "@/lib/format";
import { Preview, type PreviewHandle, type PreviewMode } from "@/components/editor/Preview";
import { Timeline } from "@/components/editor/Timeline";
import { TranscriptEditor } from "@/components/editor/TranscriptEditor";
import { Alert, Badge, Button, Card, Skeleton, StatusBadge, Toggle, useToast } from "@/components/ui";

type Tab = "edit" | "captions" | "framing" | "audio" | "publish" | "qa";
const TABS: { id: Tab; label: string; icon: typeof Captions }[] = [
  { id: "edit", label: "Cut & transcript", icon: ScanText },
  { id: "captions", label: "Captions", icon: Captions },
  { id: "framing", label: "Framing", icon: Crop },
  { id: "audio", label: "Audio & speed", icon: Gauge },
  { id: "publish", label: "Hook & metadata", icon: Sparkles },
  { id: "qa", label: "Quality checks", icon: ShieldCheck },
];

interface History { past: Edit[]; present: Edit; future: Edit[]; lastKey?: string; lastAt?: number }

export default function ClipEditor() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [clip, setClip] = useState<ClipDetail | null>(null);
  const [sys, setSys] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState<History | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [publish, setPublish] = useState<Publish>({});
  const [title, setTitle] = useState("");
  const [savedMeta, setSavedMeta] = useState("");
  const [mode, setMode] = useState<PreviewMode>("edited");
  const [tab, setTab] = useState<Tab>("edit");
  const [srcT, setSrcT] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const preview = useRef<PreviewHandle>(null);
  const lastTimeUpdate = useRef(0);

  const load = useCallback(async (resetState: boolean) => {
    try {
      const c = await api.clip(id);
      setClip(c);
      if (resetState) {
        setHist({ past: [], present: c.edit, future: [] });
        setSaved(JSON.stringify(c.edit));
        setPlan(c.plan);
        setPublish(c.publish ?? {});
        setTitle(c.title);
        setSavedMeta(JSON.stringify([c.title, c.publish]));
        setSrcT(c.edit.start);
      }
      return c;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => { load(true); api.status().then(setSys).catch(() => {}); }, [load]);

  // Poll while a render is in flight.
  useEffect(() => {
    if (!clip || (clip.status !== "queued" && clip.status !== "rendering")) return;
    const t = setTimeout(async () => {
      const c = await load(false);
      if (c && c.status === "ready") toast("ok", "Render finished");
      if (c && c.status === "failed") toast("danger", c.warnings[0] ?? "Render failed");
    }, 2500);
    return () => clearTimeout(t);
  }, [clip, load, toast]);

  const edit = hist?.present;

  // Recompute the cut plan on the server whenever the edit changes (debounced).
  useEffect(() => {
    if (!edit) return;
    const t = setTimeout(async () => {
      try {
        const r = await api.plan(id, edit);
        setPlan(r.plan);
        setPlanMsg(r.message);
      } catch (e) {
        setPlanMsg(e instanceof ApiError ? e.message : "Couldn't update the preview");
      }
    }, 250);
    return () => clearTimeout(t);
  }, [edit, id]);

  const update = useCallback((fn: (e: Edit) => Edit, key?: string) => {
    setHist((h) => {
      if (!h) return h;
      const next = fn(h.present);
      const now = Date.now();
      // Coalesce rapid changes to the same control (sliders, typing) into one undo step.
      if (key && h.lastKey === key && h.lastAt && now - h.lastAt < 800) return { ...h, present: next, lastAt: now };
      return { past: [...h.past.slice(-100), h.present], present: next, future: [], lastKey: key, lastAt: now };
    });
  }, []);
  const undo = useCallback(() => setHist((h) => (h && h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h)), []);
  const redo = useCallback(() => setHist((h) => (h && h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      if (e.key === " " && tag !== "BUTTON") { e.preventDefault(); preview.current?.play(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const dirtyEdit = !!edit && JSON.stringify(edit) !== saved;
  const dirtyMeta = JSON.stringify([title, publish]) !== savedMeta;
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirtyEdit || dirtyMeta) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirtyEdit, dirtyMeta]);

  const presets = sys?.caption_presets ?? [];
  const style = useMemo(() => (presets.length && edit ? resolveStyle(presets, edit.caption) : null), [presets, edit]);
  const emphasis = useMemo(() => new Set(edit?.emphasis ?? []), [edit?.emphasis]);

  if (error) return <div className="mx-auto max-w-4xl p-8"><Alert tone="danger" title="Couldn't open this clip">{error}</Alert></div>;
  if (!clip || !edit || !plan || !hist) {
    return <div className="grid gap-6 p-6 lg:grid-cols-[380px_1fr]"><Skeleton className="aspect-[9/16]" /><div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-96" /></div></div>;
  }

  const words: Word[] = clip.context_words;
  const lo = sys?.limits.min_clip_seconds ?? 30;
  const hi = sys?.limits.max_clip_seconds ?? 60;
  const valid = plan.duration >= lo - 0.5 && plan.duration <= hi + 0.5;
  const renderBusy = clip.status === "queued" || clip.status === "rendering";
  const autoLayout = (() => {
    if (clip.qa.framing?.layout && (clip.edit.framing.layout === "auto")) return clip.qa.framing.layout;
    if (clip.source.height >= clip.source.width) return "fit";
    const fs = clip.framing_stats;
    if (fs.two_face_ratio > 0.35 && fs.clusters.length === 2) return "split";
    return fs.face_ratio >= 0.35 ? "fill" : "blur";
  })();
  const layout = edit.framing.layout === "auto" ? autoLayout : edit.framing.layout;
  const burned = clip.source.burned_text;
  const burnedStrategy = edit.burned_text.strategy === "auto" ? (clip.qa.burned_text?.applied ?? (burned?.detected ? "mask" : "none")) : edit.burned_text.strategy;

  const setCaption = (patch: Record<string, unknown>, key?: string) => update((e) => ({ ...e, caption: { ...(e.caption ?? {}), ...patch } }), key);

  const toggleWord = (i: number) => update((e) => {
    const removed = new Set(e.removed_words);
    const restored = new Set(e.restored_words);
    if (removed.has(i)) removed.delete(i);
    else if (plan.auto_removed.includes(i)) restored.add(i);
    else if (restored.has(i)) restored.delete(i);
    else removed.add(i);
    return { ...e, removed_words: [...removed], restored_words: [...restored] };
  });
  const toggleGap = (gid: number) => update((e) => {
    const s = new Set(e.restored_gaps);
    if (s.has(gid)) s.delete(gid); else s.add(gid);
    return { ...e, restored_gaps: [...s] };
  });

  async function save(render: boolean) {
    if (!edit) return;
    if (render && !valid) return toast("danger", planMsg ?? `Shorts must be ${lo}–${hi}s`);
    setBusy(render ? "render" : "save");
    try {
      const c = await api.saveClip(id, { edit, title, publish, render });
      setClip(c);
      setSaved(JSON.stringify(c.edit));
      setHist((h) => h && { ...h, present: c.edit });
      setSavedMeta(JSON.stringify([c.title, c.publish]));
      setTitle(c.title);
      setPublish(c.publish);
      toast("ok", render ? "Saved. Rendering the final version" : "Changes saved");
      if (render) setMode("rendered");
    } catch (e) {
      toast("danger", e instanceof ApiError ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  async function resetToAi() {
    update(() => clip!.ai_edit);
    toast("info", "Restored the AI-generated edit. Save to keep it");
  }

  async function regenMeta() {
    setBusy("meta");
    try {
      const c = await api.regenerate(id, "metadata");
      setPublish(c.publish);
      setTitle(c.title);
      setSavedMeta(JSON.stringify([c.title, c.publish]));
      setClip(c);
      update((e) => ({ ...e, hook: { ...e.hook, text: c.hook } }), "hook");
      toast("ok", c.publish.generator === "ai" ? "New AI metadata generated" : "Template metadata regenerated");
    } catch (e) {
      toast("danger", e instanceof ApiError ? e.message : "Couldn't regenerate");
    } finally {
      setBusy(null);
    }
  }

  const copy = (text: string) => { navigator.clipboard?.writeText(text); toast("ok", "Copied"); };
  const label = "mb-1.5 block text-xs font-medium text-muted";
  const field = "h-9 w-full rounded-lg border border-line-2 bg-panel-2 px-2.5 text-sm outline-none focus:border-violet/60";

  return (
    <div className="flex min-h-[calc(100vh-56px)] flex-col">
      {/* Top bar */}
      <div className="sticky top-14 z-20 flex flex-wrap items-center gap-3 border-b border-line bg-ink/90 px-4 py-3 backdrop-blur-xl">
        <Link href={`/app/projects/${clip.project_id}`} className="rounded-lg p-1.5 text-muted hover:bg-panel-3 hover:text-fg" aria-label="Back to project"><ArrowLeft className="h-5 w-5" /></Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title || clip.title}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <StatusBadge status={clip.status} />
            <span className={cx("font-medium tabular-nums", valid ? "text-ok" : "text-danger")}>{plan.duration.toFixed(1)}s</span>
            <span>AI cut: {clip.ai_plan_duration.toFixed(1)}s</span>
            {(dirtyEdit || dirtyMeta) && <Badge tone="warn">Unsaved changes</Badge>}
            {!dirtyEdit && clip.needs_render && clip.status !== "queued" && clip.status !== "rendering" && <Badge tone="warn">Not rendered</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={undo} disabled={!hist.past.length} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={!hist.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={resetToAi} title="Reset to AI-generated edit"><RotateCcw className="h-4 w-4" /> <span className="hidden sm:inline">Reset to AI</span></Button>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" loading={busy === "save"} disabled={!dirtyEdit && !dirtyMeta} onClick={() => save(false)}><Save className="h-4 w-4" /> Save</Button>
          <Button size="sm" variant="primary" loading={busy === "render" || renderBusy} disabled={!valid} onClick={() => save(true)}>
            <Film className="h-4 w-4" /> {renderBusy ? (clip.status === "queued" ? "Queued…" : "Rendering…") : "Save & render"}
          </Button>
          {clip.download_url && <a href={clip.download_url} className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-lime px-3 text-sm font-medium text-ink" title="Download MP4"><Download className="h-4 w-4" /></a>}
        </div>
      </div>

      {!valid && planMsg && <div className="px-4 pt-3"><Alert tone="danger">{planMsg} Drag the timeline handles or restore cuts to fix it.</Alert></div>}

      <div className="grid flex-1 gap-6 p-4 lg:grid-cols-[minmax(320px,400px)_1fr] lg:p-6">
        {/* Preview column */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-32 lg:self-start">
          <div className="inline-flex self-center rounded-xl border border-line bg-panel p-1 text-xs" role="tablist" aria-label="Preview mode">
            {([["edited", "Edited"], ["original", "Before"], ["rendered", "Rendered"]] as const).map(([m, l]) => (
              <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cx("rounded-lg px-3 py-1.5 transition", mode === m ? "bg-panel-3 text-fg" : "text-muted hover:text-fg")}>{l}</button>
            ))}
          </div>
          {style && (
            <Preview ref={preview} proxyUrl={clip.source.proxy_url} renderedUrl={clip.video_url} mode={mode} plan={plan} edit={edit} style={style}
              layout={layout} clusters={clip.framing_stats.clusters} faceTrack={clip.face_track} burnedBox={burned?.box} burnedStrategy={burnedStrategy} emphasis={emphasis}
              onTime={(t) => { const now = performance.now(); if (now - lastTimeUpdate.current > 120) { lastTimeUpdate.current = now; setSrcT(t); } }} />
          )}
          {mode === "rendered" && clip.needs_render && clip.video_url && <p className="text-center text-xs text-warn">This render is older than your latest saved edit.</p>}
        </div>

        {/* Controls column */}
        <div className="min-w-0 space-y-5">
          <Card className="p-4">
            <Timeline words={words} plan={plan} start={edit.start} end={edit.end} srcT={srcT} sourceDuration={clip.source.duration}
              onRange={(s, e2) => update((e) => ({ ...e, start: s, end: e2 }), "range")}
              onSeek={(t) => { setMode((m) => (m === "rendered" ? "edited" : m)); preview.current?.seekSource(t); setSrcT(t); }}
              onToggleGap={toggleGap} restoredGaps={edit.restored_gaps} />
          </Card>

          <div className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-panel p-1" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                className={cx("inline-flex flex-none items-center gap-1.5 rounded-lg px-3 py-2 text-sm transition", tab === t.id ? "bg-panel-3 text-fg" : "text-muted hover:text-fg")}>
                <t.icon className="h-4 w-4" /> {t.label}
              </button>
            ))}
          </div>

          {tab === "edit" && (
            <div className="space-y-4">
              <TranscriptEditor words={words} plan={plan} edit={edit} srcT={srcT} onToggleWord={toggleWord} onToggleGap={toggleGap}
                onOverride={(i, text) => update((e) => { const o = { ...e.word_overrides }; const orig = words.find((w) => w.i === i)?.w; if (!text || text === orig) delete o[i]; else o[i] = text; return { ...e, word_overrides: o }; })}
                onSetStart={(w) => w.s < edit.end - 5 && update((e) => ({ ...e, start: Math.max(0, w.s - 0.12) }))}
                onSetEnd={(w) => w.e > edit.start + 5 && update((e) => ({ ...e, end: w.e + 0.05 }))}
                onSeek={(t) => { setMode("edited"); preview.current?.seekSource(t); }} />
              <Card className="grid gap-5 p-4 sm:grid-cols-2">
                <div>
                  <label className={label} htmlFor="pause">Tighten pauses longer than <b className="text-fg">{edit.max_pause.toFixed(2)}s</b></label>
                  <input id="pause" type="range" min={0.2} max={1.5} step={0.05} value={edit.max_pause} onChange={(ev) => update((e) => ({ ...e, max_pause: Number(ev.target.value) }), "pause")} className="w-full" />
                  <div className="mt-1 flex justify-between text-[11px] text-dim"><span>Snappy</span><span>Natural</span></div>
                </div>
                <div className="space-y-3">
                  <Toggle checked={edit.remove_fillers} onChange={(v) => update((e) => ({ ...e, remove_fillers: v }))} label="Remove fillers & stutters" description='"um", "uh", "I I think"' />
                  <Button size="sm" variant="ghost" onClick={() => update((e) => ({ ...e, restored_gaps: plan.gaps.map((g) => g.id) }))}>Restore all pauses</Button>
                </div>
              </Card>
            </div>
          )}

          {tab === "captions" && style && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                {presets.map((p) => (
                  <button key={p.id} onClick={() => update((e) => ({ ...e, caption: { preset: p.id, enabled: e.caption?.enabled ?? true } }))}
                    className={cx("rounded-xl border p-3 text-left transition", style.preset === p.id ? "border-violet/60 bg-violet/10" : "border-line bg-panel hover:border-line-2")}>
                    <div className="mb-2 flex h-10 items-center justify-center rounded-lg bg-gradient-to-b from-[#2b2a44] to-[#13121c] text-[13px]"
                      style={{ fontFamily: `"${p.font}"`, fontWeight: p.bold ? 800 : 400, color: p.color, textTransform: p.uppercase ? "uppercase" : "none",
                        textShadow: p.outline ? `0 0 2px ${p.outline_color},0 0 2px ${p.outline_color}` : undefined }}>
                      <span>Big </span><span style={{ color: p.highlight_mode === "color" ? p.highlight : undefined, background: p.highlight_mode === "box" ? p.box_color.slice(0, 7) : undefined, padding: "0 3px", borderRadius: 4, marginLeft: 3 }}>idea</span>
                    </div>
                    <div className="text-xs font-medium">{p.label}</div>
                    <div className="line-clamp-2 text-[11px] text-muted">{p.description}</div>
                  </button>
                ))}
              </div>
              <Card className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
                <Toggle checked={style.enabled} onChange={(v) => setCaption({ enabled: v })} label="Show captions" />
                <Toggle checked={style.uppercase} onChange={(v) => setCaption({ uppercase: v })} label="Uppercase" />
                <Toggle checked={style.bold} onChange={(v) => setCaption({ bold: v })} label="Bold" />
                <div><label className={label}>Font</label>
                  <select className={field} value={style.font} onChange={(e) => setCaption({ font: e.target.value })}>{(sys?.fonts ?? [style.font]).map((f) => <option key={f}>{f}</option>)}</select></div>
                <div><label className={label}>Size · {style.size}px</label><input type="range" min={36} max={130} value={style.size} onChange={(e) => setCaption({ size: Number(e.target.value) }, "size")} className="w-full" /></div>
                <div><label className={label}>Vertical position · {Math.round(style.position * 100)}%</label><input type="range" min={0.3} max={0.82} step={0.01} value={style.position} onChange={(e) => setCaption({ position: Number(e.target.value) }, "pos")} className="w-full" /></div>
                <div><label className={label}>Words per caption · {style.words_per_caption}</label><input type="range" min={1} max={10} value={style.words_per_caption} onChange={(e) => setCaption({ words_per_caption: Number(e.target.value) }, "wpc")} className="w-full" /></div>
                <div><label className={label}>Outline · {style.outline}px</label><input type="range" min={0} max={12} value={style.outline} onChange={(e) => setCaption({ outline: Number(e.target.value) }, "outline")} className="w-full" /></div>
                <div><label className={label}>Shadow · {style.shadow}</label><input type="range" min={0} max={8} value={style.shadow} onChange={(e) => setCaption({ shadow: Number(e.target.value) }, "shadow")} className="w-full" /></div>
                <div><label className={label}>Highlight style</label>
                  <select className={field} value={style.highlight_mode} onChange={(e) => setCaption({ highlight_mode: e.target.value })}>
                    <option value="color">Color pop</option><option value="box">Box behind word</option><option value="none">None</option>
                  </select></div>
                <div><label className={label}>Animation</label>
                  <select className={field} value={style.animation} onChange={(e) => setCaption({ animation: e.target.value })}>
                    <option value="pop">Pop in</option><option value="fade">Fade</option><option value="none">None</option>
                  </select></div>
                <div><label className={label}>Animation speed · {style.animation_speed.toFixed(1)}×</label><input type="range" min={0.3} max={2.5} step={0.1} value={style.animation_speed} onChange={(e) => setCaption({ animation_speed: Number(e.target.value) }, "anim")} className="w-full" /></div>
                {([["color", "Text"], ["highlight", "Active word"], ["emphasis", "Emphasis"], ["outline_color", "Outline"], ["box_color", "Box / plate"]] as const).map(([k, l]) => (
                  <div key={k}><label className={label}>{l} color</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={(style[k] as string).slice(0, 7)} onChange={(e) => setCaption({ [k]: k === "box_color" && style.box ? e.target.value + (style.box_color.slice(7) || "") : e.target.value }, k)} className="h-9 w-12 cursor-pointer rounded-lg border border-line-2 bg-transparent" aria-label={`${l} color`} />
                      <span className="font-mono text-xs text-muted">{(style[k] as string).slice(0, 7)}</span>
                    </div>
                  </div>
                ))}
                <Toggle checked={style.box} onChange={(v) => setCaption({ box: v, box_color: v && style.box_color.length === 7 ? style.box_color + "B0" : style.box_color })} label="Background plate" />
              </Card>
              <p className="text-xs text-dim">Captions stay inside the 9:16 safe area: 90px side margins, and clear of the bottom 15% where the YouTube Shorts interface sits.</p>
            </div>
          )}

          {tab === "framing" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {([["auto", "Auto", `AI pick: ${autoLayout}`], ["fill", "Tracked crop", "Follows the speaker"], ["split", "Split screen", "Two speakers stacked"], ["blur", "Blurred fill", "Whole frame, nothing cropped"], ["fit", "Fit", "Scale to fit"]] as const).map(([v, l, d]) => (
                  <button key={v} onClick={() => update((e) => ({ ...e, framing: { ...e.framing, layout: v } }))}
                    disabled={v === "split" && clip.framing_stats.clusters.length !== 2}
                    className={cx("rounded-xl border p-3 text-left transition disabled:opacity-40", edit.framing.layout === v ? "border-violet/60 bg-violet/10" : "border-line bg-panel hover:border-line-2")}>
                    <div className="text-sm font-medium">{l}</div><div className="text-[11px] text-muted">{d}</div>
                  </button>
                ))}
              </div>
              <Card className="grid gap-5 p-4 sm:grid-cols-2">
                <div>
                  <Toggle checked={edit.framing.subject_x == null} onChange={(v) => update((e) => ({ ...e, framing: { ...e.framing, subject_x: v ? null : 0.5 } }))} label="Track subject automatically" description={`Face detected in ${Math.round(clip.framing_stats.face_ratio * 100)}% of frames`} />
                  {edit.framing.subject_x != null && (
                    <div className="mt-4"><label className={label}>Subject position · {Math.round(edit.framing.subject_x * 100)}%</label>
                      <input type="range" min={0} max={1} step={0.01} value={edit.framing.subject_x} onChange={(ev) => update((e) => ({ ...e, framing: { ...e.framing, subject_x: Number(ev.target.value) } }), "subject")} className="w-full" />
                      <div className="mt-1 flex justify-between text-[11px] text-dim"><span>Left</span><span>Right</span></div></div>
                  )}
                </div>
                <div><label className={label}>Zoom · {edit.framing.zoom.toFixed(2)}×</label>
                  <input type="range" min={1} max={2} step={0.05} value={edit.framing.zoom} onChange={(ev) => update((e) => ({ ...e, framing: { ...e.framing, zoom: Number(ev.target.value) } }), "zoom")} className="w-full" /></div>
              </Card>
              <Card className="p-4">
                <div className="flex items-start gap-3">
                  <ScanText className="mt-0.5 h-5 w-5 flex-none text-violet-2" />
                  <div className="flex-1">
                    <div className="text-sm font-medium">Existing on-screen text</div>
                    <p className="mt-0.5 text-xs text-muted">
                      {burned?.detected
                        ? `Detected ${burned.kind === "captions" ? "burned-in captions" : "a static overlay"} in the source. Inpainting isn't available, so CapClip can blur, crop or avoid it.`
                        : "No burned-in captions were detected in this video."}
                    </p>
                    <select className={cx(field, "mt-3 max-w-xs")} value={edit.burned_text.strategy} onChange={(e) => update((x) => ({ ...x, burned_text: { strategy: e.target.value as Edit["burned_text"]["strategy"] } }))}>
                      <option value="auto">Auto{clip.qa.burned_text?.applied ? ` (${clip.qa.burned_text.applied})` : ""}</option>
                      <option value="mask">Mask: blur the old text</option>
                      <option value="crop">Crop the text band out</option>
                      <option value="reposition">Keep it, move new captions away</option>
                      <option value="none">Leave untouched</option>
                    </select>
                    {clip.qa.burned_text?.note && <p className="mt-2 text-xs text-dim">Last render: {clip.qa.burned_text.note}</p>}
                  </div>
                </div>
              </Card>
            </div>
          )}

          {tab === "audio" && (
            <Card className="grid gap-6 p-4 sm:grid-cols-2">
              <div>
                <label className={label}>Playback speed</label>
                <div className="flex flex-wrap gap-1.5">
                  {[0.9, 1, 1.1, 1.15, 1.25, 1.5].map((s) => (
                    <button key={s} onClick={() => update((e) => ({ ...e, speed: s }))} className={cx("rounded-lg border px-3 py-1.5 text-sm", edit.speed === s ? "border-violet/60 bg-violet/10" : "border-line-2 hover:bg-panel-3")}>{s}×</button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-dim">Pitch is preserved. At {edit.speed}× the clip runs {plan.duration.toFixed(1)}s.</p>
              </div>
              <div>
                <label className={label}>Voice level · {edit.volume_db > 0 ? "+" : ""}{edit.volume_db.toFixed(1)} dB</label>
                <input type="range" min={-12} max={12} step={0.5} value={edit.volume_db} onChange={(ev) => update((e) => ({ ...e, volume_db: Number(ev.target.value) }), "vol")} className="w-full" />
                <p className="mt-2 text-xs text-dim">Exports are loudness-normalised to −14 LUFS (YouTube&apos;s reference level) after this gain.</p>
              </div>
              <Toggle checked={edit.denoise ?? true} onChange={(v) => update((e) => ({ ...e, denoise: v }))} label="Reduce background noise" description="Gentle FFT denoise plus a low-cut filter" />
            </Card>
          )}

          {tab === "publish" && (
            <div className="space-y-4">
              <Card className="space-y-4 p-4">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Opening hook</div>
                  <Toggle checked={edit.hook.show} onChange={(v) => update((e) => ({ ...e, hook: { ...e.hook, show: v } }))} label="Show on video" />
                </div>
                <input className={field} value={edit.hook.text} maxLength={80} onChange={(ev) => update((e) => ({ ...e, hook: { ...e.hook, text: ev.target.value } }), "hook")} placeholder="Short text shown in the first seconds" aria-label="Hook text" />
                <div><label className={label}>Hook duration · {edit.hook.duration.toFixed(1)}s</label>
                  <input type="range" min={1.5} max={6} step={0.5} value={edit.hook.duration} onChange={(ev) => update((e) => ({ ...e, hook: { ...e.hook, duration: Number(ev.target.value) } }), "hookdur")} className="w-full max-w-xs" /></div>
              </Card>
              <Card className="space-y-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">YouTube Shorts metadata
                    <Badge tone={publish.generator === "ai" ? "violet" : "neutral"}>{publish.generator === "ai" ? "AI-written" : "Template-based"}</Badge></div>
                  <Button size="sm" loading={busy === "meta"} onClick={regenMeta}><Wand2 className="h-4 w-4" /> Regenerate</Button>
                </div>
                <div><label className={label}>Title</label><input className={field} value={title} maxLength={100} onChange={(e) => { setTitle(e.target.value); setPublish((p) => ({ ...p, title: e.target.value })); }} /></div>
                {!!publish.titles?.length && (
                  <div className="flex flex-wrap gap-1.5">{publish.titles.map((t) => (
                    <button key={t} onClick={() => { setTitle(t); setPublish((p) => ({ ...p, title: t })); }} className="rounded-lg border border-line-2 px-2.5 py-1 text-left text-xs text-muted hover:border-violet/50 hover:text-fg">{t}</button>
                  ))}</div>
                )}
                <div><label className={label}>Description</label><textarea className={cx(field, "h-24 py-2")} value={publish.description ?? ""} onChange={(e) => setPublish((p) => ({ ...p, description: e.target.value }))} /></div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><label className={label}>Hashtags</label><input className={field} value={(publish.hashtags ?? []).join(" ")} onChange={(e) => setPublish((p) => ({ ...p, hashtags: e.target.value.split(/\s+/).filter(Boolean) }))} /></div>
                  <div><label className={label}>Keywords</label><input className={field} value={(publish.keywords ?? []).join(", ")} onChange={(e) => setPublish((p) => ({ ...p, keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))} /></div>
                  <div><label className={label}>Pinned comment</label><input className={field} value={publish.pinned_comment ?? ""} onChange={(e) => setPublish((p) => ({ ...p, pinned_comment: e.target.value }))} /></div>
                  <div><label className={label}>Thumbnail text</label><input className={field} value={publish.thumbnail_text ?? ""} onChange={(e) => setPublish((p) => ({ ...p, thumbnail_text: e.target.value }))} /></div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => copy(`${title}\n\n${publish.description ?? ""}\n\n${(publish.hashtags ?? []).join(" ")}`)}><ClipboardCopy className="h-4 w-4" /> Copy title + description</Button>
                  {clip.thumb_url && <a href={clip.thumb_url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-sm text-muted hover:bg-panel-3 hover:text-fg">Thumbnail frame</a>}
                </div>
                <p className="text-xs text-dim">Review before publishing: metadata should describe only what happens in the clip. {publish.generator !== "ai" && "Template metadata is assembled from the transcript. Configure an AI provider for AI-written copy."}</p>
              </Card>
              <Card className="p-4 text-sm">
                <div className="mb-1 font-medium">Why this moment</div>
                <p className="text-muted">{clip.reason}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs"><Badge>{CATEGORY_LABEL[clip.category] ?? clip.category}</Badge><Badge tone="violet">{Math.round(clip.score)} AI-estimated potential (ranking only)</Badge><Badge>{clip.analyzer === "anthropic" ? "Claude" : "Heuristic"} analyzer</Badge></div>
              </Card>
            </div>
          )}

          {tab === "qa" && (
            <Card className="p-4">
              {clip.qa.checks?.length ? (
                <>
                  <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                    {clip.qa.passed ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <XCircle className="h-4 w-4 text-danger" />}
                    {clip.qa.passed ? "Export passed quality checks" : "Export failed quality checks"} <span className="text-xs font-normal text-muted">(render v{clip.render_version})</span>
                  </div>
                  <ul className="divide-y divide-line">
                    {clip.qa.checks.map((c) => (
                      <li key={c.key} className="flex items-start gap-3 py-2 text-sm">
                        {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-ok" /> : c.severity === "error" ? <XCircle className="mt-0.5 h-4 w-4 flex-none text-danger" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-warn" />}
                        <div className="flex-1">{c.label}{c.detail && <span className="ml-2 text-xs text-muted">{c.detail}</span>}</div>
                      </li>
                    ))}
                  </ul>
                  {clip.qa.framing && <p className="mt-3 text-xs text-muted">Framing: <b className="text-fg">{clip.qa.framing.layout}</b>. {clip.qa.framing.reason}.</p>}
                  {clip.qa.removed_seconds != null && <p className="mt-1 text-xs text-muted">Removed {clip.qa.removed_seconds}s of pauses and fillers across {String(clip.qa.source_segments ?? "")} segments.</p>}
                </>
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted">{renderBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Quality checks run after each render.</div>
              )}
              <p className="mt-4 text-xs text-dim">Source range {tc(edit.start, true)} – {tc(edit.end, true)} · {plan.segments.length} kept segments</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
