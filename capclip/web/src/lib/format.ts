export function tc(seconds: number | null | undefined, precise = false): string {
  if (seconds == null || !isFinite(seconds)) return "--:--";
  const neg = seconds < 0;
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = precise ? (s % 60).toFixed(1).padStart(4, "0") : String(Math.floor(s % 60)).padStart(2, "0");
  return `${neg ? "-" : ""}${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${sec}`;
}

export function dur(seconds: number | null | undefined): string {
  if (seconds == null) return "-";
  if (seconds < 90) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function bytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export const CATEGORY_LABEL: Record<string, string> = {
  hook: "Strong hook",
  fact: "Surprising fact",
  humor: "Humor",
  emotional: "Emotional",
  opinion: "Opinion",
  tutorial: "Tutorial / advice",
  inspiration: "Inspiration",
  story: "Story",
  relatable: "Relatable",
  explanation: "Explanation",
  q_and_a: "Question & answer",
};

export const STAGE_LABEL: Record<string, string> = {
  created: "Created",
  awaiting_source: "Waiting for source",
  queued: "Queued",
  retrieving: "Retrieving source",
  preparing: "Preparing media",
  transcribing: "Transcribing speech",
  audio: "Analysing audio",
  scenes: "Detecting scenes",
  vision: "Analysing frames",
  selecting: "Selecting moments",
  drafting: "Drafting clips",
  rendering: "Rendering clips",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
