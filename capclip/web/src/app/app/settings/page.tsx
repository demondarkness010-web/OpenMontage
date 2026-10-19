"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleSlash, Trash2 } from "lucide-react";
import { api, ApiError, type Me } from "@/lib/api";
import { bytes, cx } from "@/lib/format";
import { Alert, Button, Card, Modal, Skeleton, Toggle, usePoll, useToast } from "@/components/ui";

export default function Settings() {
  const toast = useToast();
  const { data: me, setData } = usePoll(() => api.me(), [], () => null);
  const { data: sys } = usePoll(() => api.status(), [], () => null);
  const [draft, setDraft] = useState<Me | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { if (me && !draft) setDraft(me); }, [me, draft]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const m = await api.updateMe({ display_name: draft.display_name, email: draft.email ?? "", preferences: draft.preferences });
      setData(m);
      setDraft(m);
      toast("ok", "Settings saved");
    } catch (e) {
      toast("danger", e instanceof ApiError ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  const setPref = <K extends keyof Me["preferences"]>(k: K, v: Me["preferences"][K]) => setDraft((d) => d && { ...d, preferences: { ...d.preferences, [k]: v } });
  const input = "h-10 w-full rounded-xl border border-line-2 bg-panel-2 px-3 text-sm outline-none focus:border-violet/60";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Account &amp; settings</h1>
      {!draft ? <Skeleton className="mt-6 h-96" /> : (
        <div className="mt-6 space-y-6">
          <Card className="p-6">
            <h2 className="font-display text-lg font-semibold">Profile</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm"><span className="mb-1.5 block text-muted">Display name</span>
                <input className={input} value={draft.display_name} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} /></label>
              <label className="text-sm"><span className="mb-1.5 block text-muted">Email (optional)</span>
                <input className={input} type="email" value={draft.email ?? ""} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></label>
            </div>
            <p className="mt-3 text-xs text-dim">This workspace is tied to a secure cookie in this browser. {draft.projects} project(s) · {bytes(draft.storage_bytes)} of rendered media on this server.</p>
          </Card>

          <Card className="p-6">
            <h2 className="font-display text-lg font-semibold">Defaults for new projects</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-sm"><span className="mb-1.5 block text-muted">Caption preset</span>
                <select className={input} value={draft.preferences.caption_preset} onChange={(e) => setPref("caption_preset", e.target.value)}>
                  {sys?.caption_presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select></label>
              <label className="text-sm"><span className="mb-1.5 block text-muted">Existing burned-in captions</span>
                <select className={input} value={draft.preferences.burned_text_strategy} onChange={(e) => setPref("burned_text_strategy", e.target.value)}>
                  <option value="auto">Auto (choose per clip)</option>
                  <option value="mask">Mask: blur the old text</option>
                  <option value="crop">Crop it out when safe</option>
                  <option value="reposition">Move new captions away from it</option>
                  <option value="none">Leave untouched</option>
                </select></label>
              <label className="text-sm"><span className="mb-1.5 block text-muted">Keep projects for</span>
                <select className={input} value={draft.preferences.retention_days} onChange={(e) => setPref("retention_days", Number(e.target.value))}>
                  {[7, 14, 30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select></label>
            </div>
            <div className="mt-6 space-y-4">
              <Toggle checked={draft.preferences.auto_render} onChange={(v) => setPref("auto_render", v)} label="Render clips automatically" description="Render every clip as soon as analysis finishes. Turn off to review drafts first." />
              <Toggle checked={draft.preferences.remove_fillers} onChange={(v) => setPref("remove_fillers", v)} label="Remove filler words and stutters" description='Cuts "um", "uh" and immediate repeats such as "I I think".' />
              <Toggle checked={draft.preferences.export_srt} onChange={(v) => setPref("export_srt", v)} label="Include SRT files in exports" />
            </div>
            <div className="mt-6 flex justify-end"><Button variant="primary" loading={saving} onClick={save}>Save settings</Button></div>
          </Card>

          <Card className="p-6">
            <h2 className="font-display text-lg font-semibold">System status</h2>
            <p className="mt-1 text-sm text-muted">What this CapClip server can do right now. Keys are configured on the server and never sent to your browser.</p>
            {!sys ? <Skeleton className="mt-4 h-40" /> : (
              <ul className="mt-4 divide-y divide-line rounded-xl border border-line">
                {[
                  { ok: sys.ffmpeg.available && sys.ffmpeg.libass, label: "Video rendering (FFmpeg + libass)", detail: sys.ffmpeg.available ? (sys.ffmpeg.libass ? "H.264/AAC export with burned-in captions" : "FFmpeg found but built without libass") : "FFmpeg not found on the server" },
                  { ok: sys.transcription.configured, label: "Speech recognition", detail: sys.transcription.configured ? `${sys.transcription.provider === "local" ? "faster-whisper, local" : "OpenAI Whisper, cloud"} · ${sys.transcription.model} · word timestamps` : sys.transcription.hint },
                  { ok: sys.ai.configured, label: "Multimodal AI clip selection & metadata", detail: sys.ai.configured ? `Claude (${sys.ai.model}), with transcript, visual timeline and frames` : sys.ai.hint },
                  { ok: sys.retrieval.youtube_download_enabled, label: "Direct YouTube retrieval", detail: sys.retrieval.youtube_download_enabled ? "Enabled. Users must confirm they hold the rights to each video" : `${sys.retrieval.reason} To enable it, set CAPCLIP_ENABLE_YOUTUBE_DOWNLOAD=true, and only for content you're licensed to process.` },
                  { ok: false, label: "Speaker identification", detail: "Not available with the current transcriber. Captions aren't labelled by speaker." },
                  { ok: false, label: "Burned-in caption inpainting", detail: "Not available. Detected text is blurred, cropped or avoided instead, and labelled honestly." },
                ].map((r) => (
                  <li key={r.label} className="flex gap-3 px-4 py-3">
                    {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-ok" /> : <CircleSlash className="mt-0.5 h-4 w-4 flex-none text-dim" />}
                    <div><div className={cx("text-sm font-medium", !r.ok && "text-muted")}>{r.label}</div><div className="text-xs text-muted">{r.detail}</div></div>
                  </li>
                ))}
              </ul>
            )}
            {sys && (
              <p className="mt-3 text-xs text-dim">Limits: uploads up to {sys.limits.max_upload_mb} MB · sources up to {sys.limits.max_source_minutes} min · clips {sys.limits.min_clip_seconds}–{sys.limits.max_clip_seconds}s · {sys.limits.max_clips_per_project ? `max ${sys.limits.max_clips_per_project} clips per project` : "no clip quota"}.</p>
            )}
          </Card>

          <Card className="border-danger/20 p-6">
            <h2 className="font-display text-lg font-semibold">Delete my data</h2>
            <p className="mt-1 text-sm text-muted">Permanently deletes every project, upload, transcript, render and export in this workspace.</p>
            <Button variant="danger" className="mt-4" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" /> Delete everything</Button>
          </Card>
        </div>
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Delete all data?">
        <Alert tone="danger">This can&apos;t be undone.</Alert>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button variant="danger" onClick={async () => { await api.deleteAllData(); setConfirm(false); toast("ok", "All data deleted"); setData(await api.me()); }}>Delete everything</Button>
        </div>
      </Modal>
    </div>
  );
}
