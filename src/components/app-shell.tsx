"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  Bot,
  CalendarCheck,
  FlaskConical,
  Grid3x3,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  Plug,
  Settings,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { NAV } from "@/lib/data/platform";
import { BookingProvider } from "@/lib/booking/store";
import { authClient } from "@/lib/auth-client";
import { AssistantPanel } from "./assistant-panel";
import { clsx } from "./clsx";

const ICONS = { LayoutDashboard, Grid3x3, CalendarCheck, Workflow, Network, ShieldCheck, FlaskConical, BarChart3, Plug, Settings };

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500 shadow-[0_0_24px_-4px_rgba(34,211,238,0.6)]">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-[#060a14]" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <path d="M4 7h10M4 12h16M4 17h7" />
          <circle cx="18" cy="7" r="1.6" fill="currentColor" />
          <circle cx="15" cy="17" r="1.6" fill="currentColor" />
        </svg>
      </div>
      <div className="leading-tight">
        <p className="font-mono text-sm font-bold tracking-[0.18em] text-white">FLOWOPS</p>
        <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">Agent Matrix</p>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex h-full flex-col gap-1 px-3 py-4">
      <div className="mb-5 px-2">
        <Logo />
      </div>
      <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">Operations</p>
      {NAV.map((item) => {
        const Icon = ICONS[item.icon];
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={clsx(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
              active
                ? "bg-gradient-to-r from-cyan-400/15 to-transparent text-white shadow-[inset_2px_0_0_0_rgb(34,211,238)]"
                : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
            )}
          >
            <Icon className={clsx("h-4 w-4", active ? "text-cyan-300" : "text-slate-500 group-hover:text-slate-300")} />
            {item.label}
            {item.href === "/booking" && (
              <span className="ml-auto rounded bg-emerald-400/15 px-1.5 py-px font-mono text-[9px] uppercase text-emerald-300">live</span>
            )}
          </Link>
        );
      })}
      <div className="mt-auto rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[11px] leading-relaxed text-slate-500">
        <p className="font-mono text-slate-400">v2.0 · beta</p>
        <p>Bookings are saved in Postgres per organization. Calendar, email &amp; SMS stay simulated until connected in Administration.</p>
      </div>
    </nav>
  );
}

export interface ShellSession {
  name: string;
  email: string;
  role: "owner" | "admin" | "staff";
  orgName: string;
  orgSlug: string;
  emailVerified: boolean;
  /** Resend configured → verification emails can actually be sent. */
  emailLive: boolean;
}

function VerifyBanner({ session }: { session: ShellSession }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  if (session.emailVerified) return null;
  return (
    <div className="relative border-b border-amber-400/20 bg-amber-400/[0.06] px-4 py-2 text-xs text-amber-100 lg:px-8" role="status" data-testid="verify-banner">
      <span className="font-semibold">Verify your email.</span> {session.email} isn&apos;t verified yet.{" "}
      {session.emailLive ? (
        state === "sent" ? (
          <span>Verification email sent — check your inbox.</span>
        ) : (
          <button
            disabled={state === "sending"}
            className="underline underline-offset-2 hover:text-white disabled:opacity-50"
            onClick={async () => {
              setState("sending");
              const r = await authClient.sendVerificationEmail({ email: session.email, callbackURL: "/verify-email" });
              setState(r.error ? "error" : "sent");
            }}
          >
            {state === "error" ? "Couldn't send — try again" : "Send verification email"}
          </button>
        )
      ) : (
        <span className="text-amber-200/70">Verification emails start once email (Resend) is connected — nothing is blocked until then.</span>
      )}
    </div>
  );
}

function UserMenu({ session }: { session: ShellSession }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <div className="hidden text-right leading-tight md:block">
        <p className="text-xs text-slate-200">{session.name}</p>
        <p className="font-mono text-[10px] uppercase text-slate-500">{session.role}</p>
      </div>
      <button
        title="Sign out"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await authClient.signOut();
          router.push("/sign-in");
          router.refresh();
        }}
        className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-40"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

export function AppShell({ children, session }: { children: React.ReactNode; session: ShellSession }) {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  return (
    <BookingProvider>
      <div className="flex min-h-screen overflow-x-clip bg-[#060a14] text-slate-200">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(34,211,238,0.08),transparent_45%),radial-gradient(ellipse_at_bottom_right,rgba(139,92,246,0.08),transparent_45%)]" />
        <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:40px_40px]" />

        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r border-white/[0.06] bg-[#070c18]/90 lg:block">
          <Sidebar />
        </aside>

        {navOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={() => setNavOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-64 border-r border-white/[0.06] bg-[#070c18]">
              <Sidebar onNavigate={() => setNavOpen(false)} />
            </aside>
          </div>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-white/[0.06] bg-[#060a14]/80 px-4 backdrop-blur lg:px-8">
            <button className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </button>
            <div className="hidden items-center gap-2 font-mono text-[11px] text-slate-500 sm:flex">
              <span className="text-slate-400">Unified Operations Intelligence Platform</span>
              <span className="text-slate-700">/</span>
              <span>org: {session.orgName}</span>
              <span className="text-slate-700">/</span>
              <a href={`/book/${session.orgSlug}`} target="_blank" className="text-cyan-400/80 hover:text-cyan-300">
                public booking page ↗
              </a>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden items-center gap-1.5 rounded-full border border-white/[0.08] px-2.5 py-1 text-[11px] text-slate-400 md:inline-flex">
                <Bot className="h-3.5 w-3.5 text-cyan-300" /> FLOWOPS Core · beta
              </span>
              <UserMenu session={session} />
              <button
                onClick={() => setAssistantOpen((v) => !v)}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-violet-500 px-3 py-1.5 text-sm font-medium text-white shadow-[0_0_20px_-6px_rgba(34,211,238,0.8)] transition hover:brightness-110"
              >
                {assistantOpen ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                FlowAI Assistant
              </button>
            </div>
          </header>
          <VerifyBanner session={session} />
          <main className="relative mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 lg:px-8">{children}</main>
        </div>

        <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />
      </div>
    </BookingProvider>
  );
}
