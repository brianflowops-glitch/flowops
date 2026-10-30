import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bot, CalendarCheck, CalendarDays, Check, Link2, Mail, ShieldCheck, Users } from "lucide-react";
import { CONTACT_EMAIL, MarketingShell, PILOT_MAILTO } from "@/components/marketing/site-chrome";

export const metadata: Metadata = {
  title: { absolute: "FlowOps — Online booking and an AI assistant for small service businesses" },
  description:
    "FlowOps gives small service businesses a public booking page, Google Calendar sync, automatic email confirmations, team roles and FlowAI — an assistant that books, moves and cancels appointments for you.",
  alternates: { canonical: "https://flowopsagent.ai/" },
  openGraph: {
    title: "FlowOps — booking and operations for small service businesses",
    description: "Booking page, calendar sync, email confirmations, team roles and an AI assistant that takes action. Founding pilot spots open — free during pilot.",
    url: "https://flowopsagent.ai/",
    siteName: "FlowOps",
    type: "website",
  },
};

const FEATURES = [
  {
    icon: Link2,
    title: "Your own booking page",
    body: "Customers pick a service, a day and an open time — no account or app needed. Share one link on your website, Google profile, texts or social.",
  },
  {
    icon: CalendarDays,
    title: "Google Calendar sync",
    body: "Every booking, reschedule and cancellation lands on your Google Calendar, so your day is in the place you already look.",
  },
  {
    icon: Mail,
    title: "Automatic email confirmations",
    body: "Customers get an email when they book and whenever an appointment is moved or cancelled. Email reminders before the appointment are next on the roadmap.",
  },
  {
    icon: Bot,
    title: "FlowAI — an assistant that takes action",
    body: "Type “move Jane's Tuesday visit to Thursday at 10” and FlowAI checks availability and does it. Cancellations always ask you to confirm first.",
  },
  {
    icon: Users,
    title: "Team roles",
    body: "Invite Admins and Staff by email. Staff run the schedule; only the Owner changes business settings. Each business's data stays in its own workspace.",
  },
  {
    icon: ShieldCheck,
    title: "No double-booking",
    body: "Every request is checked against your hours and resources — a crew, a truck, a room — before it's confirmed, and every change is logged.",
  },
];

const STEPS = [
  { title: "Set up your business", body: "Add your business name, opening hours and the services you offer, with how long each one takes." },
  { title: "Share your booking link", body: "Put your FlowOps link anywhere customers find you. They book open times around the clock." },
  { title: "Run your day from one place", body: "Bookings show up on your dashboard and Google Calendar, customers get confirmations, and FlowAI handles changes when you ask." },
];

const PILOT = [
  "Free for the length of the pilot",
  "Hands-on help setting up your booking page and services",
  "A direct line to the team building FlowOps — your feedback shapes what ships next",
];

export default function HomePage() {
  return (
    <MarketingShell>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(34,211,238,0.12),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(139,92,246,0.10),transparent_50%)]" />
        <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
          <p className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/[0.06] px-3 py-1 text-xs font-medium text-cyan-200">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" /> Founding pilot spots open — free during pilot
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            Bookings, calendar and customer updates — handled.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-300">
            FlowOps is the operations app for small service businesses. Customers book themselves online, your calendar stays in sync, confirmations go out
            automatically, and FlowAI makes schedule changes when you ask.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link href="/sign-up" className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-400 px-5 py-3 font-semibold text-[#04121a] hover:brightness-110">
              Create your free account <ArrowRight className="h-4 w-4" />
            </Link>
            <a href={PILOT_MAILTO} className="inline-flex items-center justify-center rounded-lg border border-white/15 px-5 py-3 font-medium text-white hover:bg-white/5">
              Apply for the founding pilot
            </a>
          </div>
          <p className="mt-4 text-sm text-slate-500">Built for contractors, field crews, studios, shops and other appointment-based businesses.</p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-16 border-t border-white/[0.06] bg-[#070c18]">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-3xl font-semibold tracking-tight text-white">What FlowOps does for you</h2>
          <p className="mt-3 max-w-2xl text-slate-400">The front desk work that eats your evenings — taking bookings, keeping the calendar straight and keeping customers in the loop.</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-xl border border-white/[0.07] bg-[#0d1424]/80 p-5">
                <f.icon className="h-5 w-5 text-cyan-300" aria-hidden />
                <h3 className="mt-3 font-semibold text-white">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-16 border-t border-white/[0.06]">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-3xl font-semibold tracking-tight text-white">How it works</h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-xl border border-white/[0.07] p-5">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-cyan-400/15 font-mono text-sm font-semibold text-cyan-200">{i + 1}</span>
                <h3 className="mt-4 font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{s.body}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 flex items-start gap-3 rounded-xl border border-white/[0.07] bg-[#0d1424]/60 p-4 text-sm text-slate-400">
            <CalendarCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" aria-hidden />
            <p>
              Ask FlowAI things like <span className="text-slate-200">“What&apos;s booked tomorrow?”</span> or{" "}
              <span className="text-slate-200">“Book a site visit for Sam Lee on Friday at 2”</span>. It uses the same checks as your booking page, and every
              change it makes is recorded.
            </p>
          </div>
        </div>
      </section>

      {/* Pilot CTA */}
      <section id="pilot" className="scroll-mt-16 border-t border-white/[0.06] bg-[#070c18]">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="grid gap-8 rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-400/[0.08] to-violet-500/[0.06] p-6 sm:p-10 lg:grid-cols-[1.3fr_1fr]">
            <div>
              <p className="text-sm font-medium text-cyan-200">Founding pilot program</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Founding pilot spots open — free during pilot.</h2>
              <p className="mt-3 text-slate-300">
                We&apos;re working with a small group of local service businesses to run FlowOps day to day before a wider launch. Pilot businesses use it free
                while we fine-tune it around how they actually work.
              </p>
              <ul className="mt-5 space-y-2 text-sm text-slate-200">
                {PILOT.map((p) => (
                  <li key={p} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden /> {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col justify-center gap-3">
              <a href={PILOT_MAILTO} className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-400 px-5 py-3 font-semibold text-[#04121a] hover:brightness-110">
                Apply for a pilot spot <ArrowRight className="h-4 w-4" />
              </a>
              <Link href="/sign-up" className="inline-flex items-center justify-center rounded-lg border border-white/15 px-5 py-3 font-medium text-white hover:bg-white/5">
                Or create an account now
              </Link>
              <p className="text-center text-xs text-slate-500">
                Questions? Email <a href={`mailto:${CONTACT_EMAIL}`} className="text-slate-300 hover:underline">{CONTACT_EMAIL}</a>
              </p>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
