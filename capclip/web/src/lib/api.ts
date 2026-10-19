// Typed client for the CapClip API (proxied same-origin by next.config.ts).

export type ProjectStatus =
  | "draft" | "awaiting_source" | "queued" | "processing" | "rendering" | "completed" | "failed" | "cancelled";

export interface Publish {
  title?: string;
  hook?: string;
  titles?: string[];
  description?: string;
  hashtags?: string[];
  keywords?: string[];
  pinned_comment?: string;
  thumbnail_text?: string;
  generator?: "ai" | "template";
}

export interface QaCheck { key: string; ok: boolean; label: string; detail: string; severity: "info" | "warning" | "error" }

export interface Clip {
  id: string;
  project_id: string;
  project_title?: string | null;
  index: number;
  status: "draft" | "queued" | "rendering" | "ready" | "failed";
  title: string;
  hook: string;
  reason: string;
  category: string;
  score: number;
  source_start: number;
  source_end: number;
  duration: number;
  caption_preset: string;
  caption_preset_label: string;
  analyzer: string;
  publish: Publish;
  warnings: string[];
  render_version: number;
  edit_version: number;
  needs_render: boolean;
  video_url: string | null;
  download_url: string | null;
  thumb_url: string | null;
  srt_url: string | null;
  qa: {
    checks?: QaCheck[];
    passed?: boolean;
    framing?: { layout: string; reason: string };
    burned_text?: { detected: boolean; applied: string; note: string; kind?: string };
    removed_seconds?: number;
    features?: Record<string, number>;
    [k: string]: unknown;
  };
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  kind: "analyze" | "render" | "export";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: number;
  message: string;
  error: string | null;
  attempts: number;
  max_attempts: number;
  project_id: string;
  clip_id: string | null;
  project_title?: string;
  clip_title?: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested: boolean;
}

export interface Project {
  id: string;
  title: string;
  status: ProjectStatus;
  stage: string;
  progress: number;
  eta_seconds: number | null;
  message: string;
  error: string | null;
  source_kind: "youtube" | "upload";
  youtube_url: string | null;
  youtube_id: string | null;
  options: Record<string, string>;
  warnings: string[];
  summary: {
    source_duration?: number;
    clips_generated?: number;
    clips_ready?: number;
    clips_failed?: number;
    analyzer?: string;
    words?: number;
    scenes?: number;
    frames_sampled?: number;
  };
  created_at: string;
  updated_at: string;
  clip_count: number;
  clips_ready: number;
  thumbnail: string | null;
  cover_url: string | null;
  source: null | {
    origin: string;
    filename: string | null;
    duration: number;
    width: number;
    height: number;
    fps: number;
    size_bytes: number;
    has_file: boolean;
    meta: { title?: string; channel?: string; thumbnail?: string; duration?: number };
    analysis: {
      burned_text?: { detected: boolean; kind?: string; position?: string; coverage?: number };
      analyzer?: string;
      transcriber?: string;
      language?: string;
      scenes?: number;
      words?: number;
      frames_sampled?: number;
      sample_fps?: number;
      face_ratio?: number;
    };
    subtitle_streams: unknown[];
    rights_attested: boolean;
    proxy_url: string | null;
  };
  clips?: Clip[];
  jobs?: Job[];
}

export interface CaptionStyle {
  preset: string;
  label?: string;
  description?: string;
  font: string;
  size: number;
  bold: boolean;
  uppercase: boolean;
  color: string;
  highlight: string;
  emphasis: string;
  outline: number;
  outline_color: string;
  shadow: number;
  shadow_color?: string;
  box: boolean;
  box_color: string;
  highlight_mode: "color" | "box" | "none";
  words_per_caption: number;
  max_chars_per_line: number;
  max_lines: number;
  position: number;
  animation: "pop" | "fade" | "none";
  animation_speed: number;
  letter_spacing: number;
  enabled?: boolean;
}

export interface Edit {
  start: number;
  end: number;
  max_pause: number;
  remove_fillers: boolean;
  removed_words: number[];
  restored_words: number[];
  restored_gaps: number[];
  word_overrides: Record<string, string>;
  speed: number;
  volume_db: number;
  denoise?: boolean;
  caption?: Partial<CaptionStyle> & { preset?: string; enabled?: boolean };
  framing: { layout: "auto" | "fill" | "blur" | "split" | "fit"; subject_x: number | null; zoom: number };
  hook: { text: string; show: boolean; duration: number };
  burned_text: { strategy: "auto" | "mask" | "crop" | "reposition" | "none" };
  emphasis?: number[];
  thumbnail_time?: number;
}

export interface PlanWord { i: number; w: string; orig: string; s: number; e: number; src_s: number; src_e: number; p: number }
export interface Plan {
  segments: { start: number; end: number }[];
  words: PlanWord[];
  gaps: { id: number; after_word: number; start: number; end: number; length: number; cut: boolean; reason: string }[];
  duration: number;
  source_duration: number;
  removed: number[];
  auto_removed: number[];
  speed: number;
}

export interface Word { i: number; w: string; s: number; e: number; p: number; seg: number }

export interface ClipDetail extends Clip {
  edit: Edit;
  ai_edit: Edit;
  plan: Plan;
  ai_plan_duration: number;
  source: { proxy_url: string | null; width: number; height: number; duration: number; burned_text?: { detected: boolean; box?: number[]; kind?: string } };
  context_words: Word[];
  framing_stats: { face_ratio: number; two_face_ratio: number; clusters: number[]; face_y?: number };
  face_track: { t: number; faces: { x: number; y: number; w: number; h: number }[] }[];
}

export interface ExportRecord {
  id: string;
  project_id: string;
  project_title: string | null;
  status: "queued" | "building" | "ready" | "failed";
  clip_count: number;
  include_srt: boolean;
  size_bytes: number;
  error: string | null;
  created_at: string;
  download_url: string | null;
}

export interface SystemStatus {
  ffmpeg: { available: boolean; libass: boolean; loudnorm: boolean };
  transcription: { provider: string; model: string | null; configured: boolean; hint: string | null; speaker_labels: boolean };
  ai: { provider: string; model: string | null; configured: boolean; multimodal: boolean; hint: string | null };
  retrieval: { youtube_download_enabled: boolean; reason: string | null };
  limits: { max_upload_mb: number; max_source_minutes: number; min_clip_seconds: number; max_clip_seconds: number; max_clips_per_project: number | null; retention_days: number };
  caption_presets: (CaptionStyle & { id: string })[];
  fonts: string[];
  inpainting: boolean;
}

export interface Me {
  id: string;
  display_name: string;
  email: string | null;
  created_at: string;
  projects: number;
  storage_bytes: number;
  preferences: {
    caption_preset: string;
    caption_overrides: Record<string, unknown>;
    burned_text_strategy: string;
    auto_render: boolean;
    export_srt: boolean;
    remove_fillers: boolean;
    retention_days: number;
  };
}

export interface ValidateResult {
  video_id: string;
  url: string;
  metadata: { title?: string; channel?: string; thumbnail?: string; duration?: number; available: boolean | null; reason?: string; lookup_error?: string; license?: string };
  retrieval: { youtube_download_enabled: boolean; reason: string | null };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { ...(init?.body && !(init.body instanceof Blob) ? { "Content-Type": "application/json" } : {}), ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "Can't reach the CapClip server. Check that the backend is running.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail;
    const msg = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d: { msg?: string }) => d.msg).join("; ") : `Request failed (${res.status})`;
    throw new ApiError(res.status, res.status >= 500 && !detail ? "The server hit an error. Try again in a moment." : msg);
  }
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  status: () => request<SystemStatus>("/api/system/status"),
  validate: (url: string) => request<ValidateResult>("/api/youtube/validate", { method: "POST", body: json({ url }) }),
  createProject: (body: { youtube_url?: string; title?: string; rights_attested?: boolean; caption_preset?: string; burned_text_strategy?: string }) =>
    request<Project>("/api/projects", { method: "POST", body: json(body) }),
  projects: (status?: string) => request<Project[]>(`/api/projects${status ? `?status=${status}` : ""}`),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  renameProject: (id: string, title: string) => request<Project>(`/api/projects/${id}`, { method: "PATCH", body: json({ title }) }),
  startProject: (id: string) => request<Project>(`/api/projects/${id}/start`, { method: "POST" }),
  attest: (id: string) => request<Project>(`/api/projects/${id}/attest`, { method: "POST" }),
  cancelProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}/cancel`, { method: "POST" }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
  clips: (params?: { project_id?: string; status?: string }) => {
    const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]);
    return request<Clip[]>(`/api/clips${q.size ? `?${q}` : ""}`);
  },
  clip: (id: string) => request<ClipDetail>(`/api/clips/${id}`),
  plan: (id: string, edit: Edit) => request<{ plan: Plan; valid: boolean; message: string | null }>(`/api/clips/${id}/plan`, { method: "POST", body: json({ edit }) }),
  saveClip: (id: string, body: { edit?: Edit; title?: string; publish?: Publish; render?: boolean }) =>
    request<ClipDetail>(`/api/clips/${id}`, { method: "PUT", body: json(body) }),
  renderClip: (id: string) => request<ClipDetail>(`/api/clips/${id}/render`, { method: "POST" }),
  resetClip: (id: string) => request<ClipDetail>(`/api/clips/${id}/reset`, { method: "POST" }),
  regenerate: (id: string, mode: "metadata" | "full" = "full") => request<ClipDetail>(`/api/clips/${id}/regenerate`, { method: "POST", body: json({ mode }) }),
  deleteClip: (id: string) => request<void>(`/api/clips/${id}`, { method: "DELETE" }),
  createExport: (project_id: string, clip_ids: string[], include_srt: boolean) =>
    request<ExportRecord>("/api/exports", { method: "POST", body: json({ project_id, clip_ids, include_srt }) }),
  exports: () => request<ExportRecord[]>("/api/exports"),
  exportRecord: (id: string) => request<ExportRecord>(`/api/exports/${id}`),
  jobs: (active = false) => request<Job[]>(`/api/jobs${active ? "?active=true" : ""}`),
  cancelJob: (id: string) => request<Job>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  me: () => request<Me>("/api/me"),
  updateMe: (body: Partial<Pick<Me, "display_name" | "email">> & { preferences?: Partial<Me["preferences"]> }) =>
    request<Me>("/api/me", { method: "PUT", body: json(body) }),
  deleteAllData: () => request<void>("/api/me/data", { method: "DELETE" }),
};

const CHUNK = 8 * 1024 * 1024;

/** Resumable chunked upload. Resumes from the server's byte count on conflict. */
export async function uploadSource(projectId: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<Project> {
  let offset = 0;
  let retries = 0;
  const name = encodeURIComponent(file.name);
  while (true) {
    if (signal?.aborted) throw new ApiError(0, "Upload cancelled");
    const chunk = file.slice(offset, offset + CHUNK);
    let res: Response;
    try {
      res = await fetch(`/api/projects/${projectId}/upload?offset=${offset}&total=${file.size}&filename=${name}`, {
        method: "PUT",
        body: chunk,
        headers: { "Content-Type": "application/octet-stream" },
        credentials: "same-origin",
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new ApiError(0, "Upload cancelled");
      if (++retries > 5) throw new ApiError(0, "Upload interrupted. Check your connection and try again.");
      await new Promise((r) => setTimeout(r, 1500 * retries));
      void e;
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && typeof data.received === "number") {
      offset = data.received;
      continue;
    }
    if (!res.ok) throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `Upload failed (${res.status})`);
    retries = 0;
    offset = data.received;
    onProgress(offset / file.size);
    if (data.complete) return data.project as Project;
  }
}
