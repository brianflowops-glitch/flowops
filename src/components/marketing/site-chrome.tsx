import Link from "next/link";

export const CONTACT_EMAIL = "brian.flowops@gmail.com";
export const COMPANY_NAME = "FlowOps Inc.";
export const COMPANY_ADDRESS = "235 Nothstein Road, Lehighton, PA 18235, USA";
export const PILOT_MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("FlowOps founding pilot")}&body=${encodeURIComponent(
  "Hi Brian,\n\nI'd like to join the FlowOps founding pilot.\n\nBusiness name:\nWhat we do:\nHow customers book us today:\nBest phone/email to reach me:\n",
)}`;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#060a14]/85 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6" aria-label="Main">
        <Link href="/" className="font-mono text-sm font-bold tracking-[0.18em] text-white">
          FLOWOPS
        </Link>
        <div className="ml-6 hidden items-center gap-5 text-sm text-slate-400 md:flex">
          <Link href="/#features" className="hover:text-white">Features</Link>
          <Link href="/#how-it-works" className="hover:text-white">How it works</Link>
          <Link href="/#pilot" className="hover:text-white">Pilot program</Link>
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <Link href="/sign-in" className="rounded-lg px-3 py-1.5 text-slate-300 hover:bg-white/5 hover:text-white">
            Sign in
          </Link>
          <Link href="/sign-up" className="rounded-lg bg-cyan-400 px-3 py-1.5 font-semibold text-[#04121a] hover:brightness-110">
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-[#050812]">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:px-6">
        <p>
          <span className="font-mono font-bold tracking-[0.18em] text-slate-300">FLOWOPS</span>
          <span className="ml-3">© 2026 FlowOps Inc.</span>
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-2 sm:ml-auto">
          <Link href="/terms" className="hover:text-slate-200">Terms</Link>
          <Link href="/privacy" className="hover:text-slate-200">Privacy</Link>
          <Link href="/sms-consent" className="hover:text-slate-200">SMS consent</Link>
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-slate-200">Contact</a>
          <Link href="/sign-in" className="hover:text-slate-200">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}

export function MarketingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[#060a14] text-slate-200">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

/** Wrapper for the legal pages (Terms, Privacy). */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <MarketingShell>
      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">Effective date: {updated} · Last updated {updated}</p>
        <div className="legal mt-8 space-y-6 text-[15px] leading-7 text-slate-300">{children}</div>
      </article>
    </MarketingShell>
  );
}

export function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-4 text-xl font-semibold text-white">{children}</h2>;
}
export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc space-y-2 pl-6">{children}</ul>;
}
