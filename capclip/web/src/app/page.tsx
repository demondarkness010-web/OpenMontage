import Link from "next/link";
import {
  AudioLines, Captions, ChevronDown, Crop, Download, Eye, Layers, ListChecks, MessageSquareQuote, PenLine, ScanFace, Scissors, Sparkles, Zap,
} from "lucide-react";
import { EditorMock } from "@/components/EditorMock";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { SourceForm } from "@/components/SourceForm";

const STEPS = [
  { n: "01", title: "Paste a link", body: "Drop in a YouTube URL. CapClip checks it and reads the public details. If downloading isn't permitted, you upload the file instead." },
  { n: "02", title: "CapClip watches all of it", body: "Every minute is transcribed word by word, every scene change is found, and frames are sampled across the whole video for faces, motion and on-screen text." },
  { n: "03", title: "Review, tweak, download", body: "You get every moment worth posting as a 9:16 MP4 with fresh captions, tightened pacing and publishing copy. Adjust anything, then export one clip or all of them." },
];

const FEATURES = [
  { icon: Eye, title: "Full-video understanding", body: "Transcript, prosody, scene cuts and sampled frames are combined, so clips are chosen for meaning and payoff, not loudness." },
  { icon: Sparkles, title: "No clip quota", body: "As many Shorts as the video genuinely supports, and no near-duplicates. When a video has too little material, CapClip says so instead of stretching it." },
  { icon: Scissors, title: "Pacing that breathes", body: "Dead air, fillers and stutters are cut at word boundaries with padding, so sentences stay whole and nothing gets clipped." },
  { icon: ScanFace, title: "Built for vertical", body: "Face-tracked crops with smooth easing, split-screen for two speakers, or a blurred fill when cropping would lose the content." },
  { icon: Captions, title: "Captions, rebuilt", body: "Old subtitle tracks are dropped. Burned-in text is detected and masked, cropped or worked around, and the result is reported honestly." },
  { icon: MessageSquareQuote, title: "Publishing copy", body: "Hook text, title options, a description, hashtags, keywords and a pinned-comment prompt, all grounded in what the clip actually says." },
  { icon: PenLine, title: "A real editor", body: "Trim on a word-level timeline, fix transcript errors, restore pauses, reframe, restyle captions. Every change is in the final render." },
  { icon: Download, title: "Export your way", body: "H.264 MP4s with burned-in captions, optional SRT files, and a metadata sheet, one at a time or as a ZIP." },
];

const DEMO = [
  { title: "Why 50-hour weeks backfire", cat: "Surprising fact", dur: "47s", g: "from-[#2a1f5c] to-[#0f0d1f]", cap: "OUTPUT PER HOUR DROPS" },
  { title: "The 30-day sleep experiment", cat: "Story", dur: "58s", g: "from-[#1f3a5c] to-[#0d141f]", cap: "LIGHTS OUT AT 10:30" },
  { title: "The two-minute rule", cat: "Tutorial / advice", dur: "36s", g: "from-[#3d5c1f] to-[#121a0b]", cap: "DO IT RIGHT NOW" },
  { title: "Where your hours really go", cat: "Question & answer", dur: "52s", g: "from-[#5c1f3d] to-[#1f0d16]", cap: "CONTEXT SWITCHING" },
];

const FAQ = [
  ["Can CapClip download any YouTube video?", "No. A public link doesn't mean you have permission to download or re-edit a video. CapClip always validates the link and reads its public details. It downloads only when the server operator has enabled retrieval and you confirm you own the video or are licensed to use it. Otherwise you upload the file. It never bypasses private, age-restricted, members-only or DRM-protected videos."],
  ["How many Shorts will I get?", "There's no fixed number. CapClip returns every moment that stands on its own at 30–60 seconds, and skips filler, intros and repeats. A 10-minute talk might give 3 clips, a 2-hour podcast 25 or more."],
  ["Will it remove the captions already burned into my video?", "It detects burned-in text and, depending on your setting, blurs it out, crops it away when that's safe, or moves the new captions clear of it. Blurring hides the text but doesn't erase it, and CapClip labels it that way. Separate subtitle tracks are always dropped."],
  ["Which AI does CapClip use?", "Speech is transcribed locally with Whisper, or in the cloud with an OpenAI key. When an Anthropic API key is configured, Claude reviews the full transcript, a visual timeline and sampled frames to pick moments and write the metadata. Without a key, a local heuristic analyzer is used and the results are labelled that way."],
  ["Is the engagement score a prediction of views?", "No. It's a relative ranking signal that helps you decide what to post first. Nobody can guarantee views, and CapClip doesn't claim to."],
  ["What happens to my uploads?", "Media is stored privately and served only through expiring signed links. Projects are deleted automatically after your retention period, and you can delete everything at any time in Settings."],
];

export default function Landing() {
  return (
    <div className="relative overflow-x-hidden">
      <SiteHeader />
      {/* Hero */}
      <section className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 md:pt-24">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_45%_at_50%_0%,rgba(139,92,246,.22),transparent_70%)]" />
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-line-2 bg-panel px-3 py-1 text-xs text-muted">
            <Zap className="h-3.5 w-3.5 text-lime" /> Full-video analysis · 9:16 · fresh captions
          </span>
          <h1 className="font-display text-5xl font-bold leading-[1.02] tracking-tight sm:text-7xl">
            One Video.<br />
            <span className="bg-gradient-to-r from-violet-2 via-violet to-lime bg-clip-text text-transparent">Endless Shorts.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted">
            Paste a link. CapClip watches the whole video, finds every moment worth posting, tightens the pacing and delivers ready-to-publish vertical Shorts with new captions and titles.
          </p>
          <div className="mt-10 flex w-full justify-center" id="start">
            <SourceForm />
          </div>
        </div>
      </section>

      {/* Product preview */}
      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <EditorMock />
      </section>

      {/* How it works */}
      <section id="how" className="border-y border-line bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">How CapClip works</h2>
          <p className="mt-3 max-w-2xl text-muted">One long video goes in. A folder of finished Shorts comes out, with each cut, caption and title open for you to review.</p>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="relative rounded-2xl border border-line bg-panel p-6">
                <div className="font-display text-sm font-semibold text-violet-2">{s.n}</div>
                <h3 className="mt-3 font-display text-xl font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 grid grid-cols-2 gap-3 text-sm text-muted sm:grid-cols-4">
            {[[AudioLines, "Word-level transcription"], [Layers, "Scene detection"], [Crop, "Smart 9:16 reframing"], [ListChecks, "Export quality checks"]].map(([Icon, label]) => {
              const I = Icon as typeof AudioLines;
              return (
                <div key={label as string} className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2.5"><I className="h-4 w-4 text-violet-2" />{label as string}</div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">An editor, a strategist and a render farm</h2>
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-panel p-6 transition hover:bg-panel-2">
              <f.icon className="h-5 w-5 text-violet-2" />
              <h3 className="mt-4 font-medium">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Demo gallery */}
      <section id="gallery" className="border-y border-line bg-panel/40">
        <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Sample results</h2>
              <p className="mt-3 max-w-xl text-muted">Example cards showing the kind of clips CapClip produces from a single 3-minute talk.</p>
            </div>
            <span className="rounded-full border border-warn/30 bg-warn/10 px-3 py-1 text-xs font-medium text-warn">Demo content: illustrative, not real output</span>
          </div>
          <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-4">
            {DEMO.map((d) => (
              <div key={d.title} className="group">
                <div className={`relative aspect-[9/16] overflow-hidden rounded-2xl border border-line bg-gradient-to-b ${d.g}`}>
                  <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warn">Demo</span>
                  <span className="absolute right-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white">{d.dur}</span>
                  <div className="absolute left-1/2 top-[28%] h-[22%] w-[38%] -translate-x-1/2 rounded-[40%] bg-white/10" />
                  <div className="absolute inset-x-3 top-[64%] text-center font-display text-base font-black leading-tight text-white [text-shadow:0_2px_0_#000]">{d.cap}</div>
                </div>
                <div className="mt-3 text-sm font-medium">{d.title}</div>
                <div className="text-xs text-muted">{d.cat}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto max-w-3xl px-4 py-24 sm:px-6">
        <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">Questions, answered</h2>
        <div className="mt-10 divide-y divide-line rounded-2xl border border-line bg-panel">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {q}
                <ChevronDown className="h-4 w-4 flex-none text-muted transition group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted">{a}</p>
            </details>
          ))}
        </div>
        <div className="mt-16 flex flex-col items-center gap-4 rounded-3xl border border-violet/30 bg-gradient-to-b from-violet/10 to-transparent p-10 text-center">
          <h3 className="font-display text-2xl font-semibold">Ready to turn one video into a week of Shorts?</h3>
          <Link href="#start" className="inline-flex h-12 items-center rounded-xl bg-violet px-6 font-medium text-white transition hover:bg-violet-2">Paste a link</Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}
