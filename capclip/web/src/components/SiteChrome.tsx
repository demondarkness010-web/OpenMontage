import Link from "next/link";
import { Logo } from "./ui";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/60 bg-ink/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="CapClip home"><Logo /></Link>
        <nav className="hidden items-center gap-7 text-sm text-muted md:flex">
          <a href="/#how" className="hover:text-fg">How it works</a>
          <a href="/#features" className="hover:text-fg">Features</a>
          <a href="/#gallery" className="hover:text-fg">Examples</a>
          <a href="/#faq" className="hover:text-fg">FAQ</a>
        </nav>
        <Link href="/app" className="inline-flex h-9 items-center rounded-xl border border-line-2 bg-panel-3 px-4 text-sm font-medium transition hover:bg-line">Open dashboard</Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-muted sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-2">
          <Logo />
          <span className="text-xs text-dim">One video. Endless Shorts. Not affiliated with YouTube or Google.</span>
        </div>
        <nav className="flex flex-wrap gap-6">
          <Link href="/privacy" className="hover:text-fg">Privacy</Link>
          <Link href="/terms" className="hover:text-fg">Terms</Link>
          <Link href="/support" className="hover:text-fg">Support</Link>
          <Link href="/app" className="hover:text-fg">Dashboard</Link>
        </nav>
      </div>
    </footer>
  );
}

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <h1 className="font-display text-4xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-8 space-y-5 text-[15px] leading-relaxed text-muted [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-fg">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
