"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Archive, Clapperboard, Download, Search } from "lucide-react";
import { api, ApiError, type Clip, type ExportRecord } from "@/lib/api";
import { CATEGORY_LABEL, bytes, cx } from "@/lib/format";
import { ClipCard } from "./ClipCard";
import { Button, Empty, Modal, useToast } from "./ui";

type Sort = "score" | "source" | "duration" | "newest";
const DURATIONS = [
  { id: "any", label: "Any length" },
  { id: "short", label: "30–40s", min: 0, max: 40 },
  { id: "mid", label: "40–50s", min: 40, max: 50 },
  { id: "long", label: "50–60s", min: 50, max: 999 },
];

export function ClipBoard({ clips, onChanged, showProject }: { clips: Clip[]; onChanged: () => void; showProject?: boolean }) {
  const toast = useToast();
  const [sort, setSort] = useState<Sort>(showProject ? "newest" : "score");
  const [category, setCategory] = useState("all");
  const [length, setLength] = useState("any");
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [regen, setRegen] = useState<Clip | null>(null);
  const [del, setDel] = useState<Clip | null>(null);
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [includeSrt, setIncludeSrt] = useState(true);
  const [exportsRunning, setExportsRunning] = useState<ExportRecord[]>([]);

  const categories = useMemo(() => Array.from(new Set(clips.map((c) => c.category))), [clips]);
  const shown = useMemo(() => {
    const d = DURATIONS.find((x) => x.id === length)!;
    const q = query.trim().toLowerCase();
    const list = clips.filter((c) =>
      (category === "all" || c.category === category) &&
      (status === "all" || c.status === status) &&
      (d.min == null || (c.duration >= d.min && c.duration < d.max!)) &&
      (!q || `${c.title} ${c.hook} ${c.reason}`.toLowerCase().includes(q)));
    const by: Record<Sort, (a: Clip, b: Clip) => number> = {
      score: (a, b) => b.score - a.score,
      source: (a, b) => a.source_start - b.source_start,
      duration: (a, b) => a.duration - b.duration,
      newest: (a, b) => b.created_at.localeCompare(a.created_at),
    };
    return [...list].sort(by[sort]);
  }, [clips, category, length, status, query, sort]);

  // Drop selections for clips that disappeared.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => clips.some((c) => c.id === id))));
  }, [clips]);

  // Poll running exports until they finish.
  useEffect(() => {
    const pending = exportsRunning.filter((e) => e.status === "queued" || e.status === "building");
    if (!pending.length) return;
    const t = setTimeout(async () => {
      const fresh = await Promise.all(exportsRunning.map((e) => (e.status === "ready" || e.status === "failed" ? e : api.exportRecord(e.id).catch(() => e))));
      fresh.forEach((e, i) => {
        if (exportsRunning[i].status !== e.status && e.status === "ready") toast("ok", `Export ready: ${e.clip_count} clip(s)`);
        if (exportsRunning[i].status !== e.status && e.status === "failed") toast("danger", `Export failed: ${e.error}`);
      });
      setExportsRunning(fresh);
    }, 1500);
    return () => clearTimeout(t);
  }, [exportsRunning, toast]);

  const readySelected = clips.filter((c) => selected.has(c.id) && c.status === "ready");
  const allShownSelected = shown.length > 0 && shown.every((c) => selected.has(c.id));

  async function doExport() {
    setBusy(true);
    try {
      const byProject = new Map<string, string[]>();
      readySelected.forEach((c) => byProject.set(c.project_id, [...(byProject.get(c.project_id) ?? []), c.id]));
      const created = await Promise.all([...byProject].map(([pid, ids]) => api.createExport(pid, ids, includeSrt)));
      setExportsRunning((x) => [...created, ...x]);
      setExportOpen(false);
      toast("info", "Building your ZIP archive…");
    } catch (e) {
      toast("danger", e instanceof ApiError ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function doRegenerate(mode: "metadata" | "full") {
    if (!regen) return;
    setBusy(true);
    try {
      await api.regenerate(regen.id, mode);
      toast("ok", mode === "full" ? "Clip reset to the AI edit with fresh metadata and queued to re-render" : "Metadata regenerated");
      setRegen(null);
      onChanged();
    } catch (e) {
      toast("danger", e instanceof ApiError ? e.message : "Couldn't regenerate");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!del) return;
    setBusy(true);
    try {
      await api.deleteClip(del.id);
      toast("ok", "Clip deleted");
      setDel(null);
      onChanged();
    } catch (e) {
      toast("danger", e instanceof ApiError ? e.message : "Couldn't delete");
    } finally {
      setBusy(false);
    }
  }

  if (!clips.length) {
    return <Empty icon={<Clapperboard className="h-6 w-6" />} title="No clips">Clips appear here once a project finishes analysis.</Empty>;
  }

  const select = "h-9 rounded-xl border border-line-2 bg-panel px-3 text-sm text-fg outline-none focus:border-violet/60";
  return (
    <div>
      <div className="sticky top-14 z-20 -mx-1 mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-panel/90 p-2 backdrop-blur-xl lg:top-2">
        <label className="flex h-9 items-center gap-2 rounded-xl border border-line-2 bg-panel px-3 text-sm">
          <input type="checkbox" checked={allShownSelected} onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...shown.map((c) => c.id)]) : new Set())} className="h-4 w-4 accent-[#8b5cf6]" aria-label="Select all shown clips" />
          <span className="text-muted">{selected.size ? `${selected.size} selected` : "Select all"}</span>
        </label>
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-dim" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles" aria-label="Search clips"
            className="h-9 w-full rounded-xl border border-line-2 bg-panel pl-9 pr-3 text-sm outline-none focus:border-violet/60" />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className={select} aria-label="Sort">
          <option value="score">Sort: AI-estimated potential</option>
          <option value="source">Sort: source timestamp</option>
          <option value="duration">Sort: duration</option>
          <option value="newest">Sort: newest</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={select} aria-label="Category">
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c] ?? c}</option>)}
        </select>
        <select value={length} onChange={(e) => setLength(e.target.value)} className={select} aria-label="Duration">
          {DURATIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={select} aria-label="Status">
          <option value="all">Any status</option>
          <option value="ready">Ready</option>
          <option value="rendering">Rendering</option>
          <option value="queued">Queued</option>
          <option value="failed">Failed</option>
          <option value="draft">Draft</option>
        </select>
        <Button variant="primary" disabled={!readySelected.length} onClick={() => setExportOpen(true)}>
          <Archive className="h-4 w-4" /> Export {readySelected.length || ""}
        </Button>
      </div>

      {exportsRunning.length > 0 && (
        <div className="mb-5 flex flex-col gap-2">
          {exportsRunning.slice(0, 3).map((e) => (
            <div key={e.id} className="flex items-center justify-between rounded-xl border border-line bg-panel-2 px-4 py-2.5 text-sm">
              <span className="text-muted">ZIP · {e.clip_count} clip(s){e.project_title && showProject ? ` · ${e.project_title}` : ""} · <span className={cx(e.status === "ready" ? "text-ok" : e.status === "failed" ? "text-danger" : "text-violet-2")}>{e.status === "building" || e.status === "queued" ? "building…" : e.status}</span>{e.size_bytes ? ` · ${bytes(e.size_bytes)}` : ""}</span>
              {e.download_url ? <a href={e.download_url} className="inline-flex items-center gap-1.5 font-medium text-lime"><Download className="h-4 w-4" /> Download ZIP</a> : e.error ? <span className="text-danger">{e.error}</span> : null}
            </div>
          ))}
          <Link href="/app/exports" className="text-xs text-muted hover:text-fg">View export history →</Link>
        </div>
      )}

      {shown.length ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((c) => (
            <ClipCard key={c.id} clip={c} showProject={showProject} selected={selected.has(c.id)}
              onSelect={(v) => setSelected((s) => { const n = new Set(s); if (v) n.add(c.id); else n.delete(c.id); return n; })}
              onRegenerate={() => setRegen(c)} onDelete={() => setDel(c)} />
          ))}
        </div>
      ) : (
        <Empty title="No clips match these filters" />
      )}

      <Modal open={exportOpen} onClose={() => setExportOpen(false)} title="Export clips">
        <p className="text-sm text-muted">{readySelected.length} finished clip(s) will be packaged as H.264 MP4s (1080×1920, captions burned in) with a metadata sheet (titles, descriptions, hashtags, timestamps).</p>
        {selected.size > readySelected.length && <p className="mt-2 text-xs text-warn">{selected.size - readySelected.length} selected clip(s) aren&apos;t rendered yet and will be skipped.</p>}
        <label className="mt-4 flex items-center gap-3 text-sm">
          <input type="checkbox" checked={includeSrt} onChange={(e) => setIncludeSrt(e.target.checked)} className="h-4 w-4 accent-[#8b5cf6]" />
          Include separate .srt caption files
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setExportOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={doExport}><Archive className="h-4 w-4" /> Build ZIP</Button>
        </div>
      </Modal>

      <Modal open={!!regen} onClose={() => setRegen(null)} title="Regenerate clip">
        <p className="text-sm text-muted">Regenerate <b className="text-fg">{regen?.title}</b>.</p>
        <div className="mt-4 grid gap-2">
          <button onClick={() => doRegenerate("full")} disabled={busy} className="rounded-xl border border-line-2 p-3 text-left transition hover:border-violet/50 hover:bg-violet/5">
            <div className="text-sm font-medium">Reset edit &amp; re-render</div>
            <div className="text-xs text-muted">Discards your edits, restores the AI cut, writes fresh title and description, and renders again.</div>
          </button>
          <button onClick={() => doRegenerate("metadata")} disabled={busy} className="rounded-xl border border-line-2 p-3 text-left transition hover:border-violet/50 hover:bg-violet/5">
            <div className="text-sm font-medium">New titles &amp; description only</div>
            <div className="text-xs text-muted">Keeps the video as it is.</div>
          </button>
        </div>
      </Modal>

      <Modal open={!!del} onClose={() => setDel(null)} title="Delete clip?">
        <p className="text-sm text-muted">This permanently deletes <b className="text-fg">{del?.title}</b> and its rendered files.</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDel(null)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={doDelete}>Delete clip</Button>
        </div>
      </Modal>
    </div>
  );
}
