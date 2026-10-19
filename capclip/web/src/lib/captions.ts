// Browser-side mirror of server/capclip/pipeline/captions.py phrase layout,
// used only for the live editor preview. The server remains the source of
// truth for the rendered file.
import type { CaptionStyle, PlanWord } from "./api";

export function resolveStyle(presets: (CaptionStyle & { id: string })[], caption: Partial<CaptionStyle> & { preset?: string } = {}): CaptionStyle & { enabled: boolean } {
  const base = presets.find((p) => p.id === (caption.preset ?? "bold_viral")) ?? presets[0];
  const merged = { ...base, ...Object.fromEntries(Object.entries(caption).filter(([, v]) => v != null)) } as CaptionStyle & { enabled?: boolean };
  return { ...merged, preset: caption.preset ?? base?.id ?? "bold_viral", enabled: caption.enabled ?? true };
}

export function buildPhrases(words: PlanWord[], style: CaptionStyle): PlanWord[][] {
  const maxWords = style.words_per_caption;
  const maxChars = style.max_chars_per_line * style.max_lines;
  const phrases: PlanWord[][] = [];
  let cur: PlanWord[] = [];
  words.forEach((w, i) => {
    const curLen = cur.reduce((n, x) => n + x.w.length + 1, 0);
    if (cur.length && (cur.length >= maxWords || curLen + w.w.length > maxChars || w.s - cur[cur.length - 1].e > 0.6)) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(w);
    const next = words[i + 1];
    const endsSentence = /[.!?]$/.test(w.w);
    const soft = /[,;:]$/.test(w.w) && cur.length >= Math.max(2, Math.floor(maxWords / 2));
    if (endsSentence || soft || (next && next.s - w.e > 0.45)) {
      phrases.push(cur);
      cur = [];
    }
  });
  if (cur.length) phrases.push(cur);
  const merged: PlanWord[][] = [];
  for (const p of phrases) {
    const last = merged[merged.length - 1];
    if (last && p.length === 1 && last.length < maxWords && p[0].s - last[last.length - 1].e < 0.25 && !/[.!?]$/.test(last[last.length - 1].w)) last.push(p[0]);
    else merged.push(p);
  }
  return merged;
}

export function lineBreak(tokens: string[], maxChars: number, maxLines: number): number[][] {
  const total = tokens.reduce((n, t) => n + t.length, 0) + tokens.length - 1;
  if (total <= maxChars || maxLines < 2 || tokens.length < 2) return [tokens.map((_, i) => i)];
  let best = 1;
  let bestCost = Infinity;
  for (let k = 1; k < tokens.length; k++) {
    const a = tokens.slice(0, k).reduce((n, t) => n + t.length, 0) + k - 1;
    const b = tokens.slice(k).reduce((n, t) => n + t.length, 0) + tokens.length - k - 1;
    const cost = Math.abs(a - b) + (Math.max(a, b) > maxChars ? 100 : 0);
    if (cost < bestCost) { best = k; bestCost = cost; }
  }
  return [tokens.slice(0, best).map((_, i) => i), tokens.slice(best).map((_, i) => i + best)];
}

export function displayText(text: string, style: CaptionStyle): string {
  let t = text.trim();
  if (style.uppercase) t = t.toUpperCase();
  if (style.preset === "bold_viral" || style.preset === "modern_creator") t = t.replace(/[,;]$/, "");
  return t;
}

export function outlineShadow(width: number, color: string, scale: number): string {
  if (width <= 0) return "none";
  const w = Math.max(0.5, width * scale);
  const steps = 12;
  return Array.from({ length: steps }, (_, k) => {
    const a = (k / steps) * Math.PI * 2;
    return `${(Math.cos(a) * w).toFixed(2)}px ${(Math.sin(a) * w).toFixed(2)}px 0 ${color}`;
  }).join(",");
}
