"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Activity } from "lucide-react";
import { useBookings } from "@/lib/booking/store";
import { MODULES, PHASES, type ModuleKey } from "@/lib/data/platform";
import { SAMPLE_OPS_KPIS } from "@/lib/data/sample";
import { Card, LiveBadge, PageHeader, Pill, SampleBadge, Stat } from "../ui";
import { PipelineView, idleSteps } from "../pipeline";
import { clsx } from "../clsx";
import { OnboardingChecklist } from "./onboarding-checklist";

const MODULE_STATUS: Record<ModuleKey, { status: string; label: string }> = {
  core: { status: "active", label: "prototype" },
  biz: { status: "active", label: "booking live" },
  connect: { status: "active", label: "calendar + email live" },
  // FlowAI runs through Vercel AI Gateway (OIDC on Vercel); downgraded below if GET /api/assistant says it isn't configured.
  ai: { status: "active", label: "live" },
  net: { status: "planned", label: "planned" },
  sec: { status: "planned", label: "planned" },
  pulse: { status: "planned", label: "planned" },
};

// Phase end dates (2026) used to highlight the current phase.
const PHASE_END = ["2026-10-25", "2026-10-27", "2026-10-29", "2026-10-31", "2026-11-02", "2026-11-03"];

export function CommandCenter() {
  const { state } = useBookings();
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- depends on client clock
    setToday(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }, []);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/assistant")
      .then((r) => r.json())
      .then((s: { configured?: boolean }) => {
        if (!cancelled) setAiConfigured(s.configured !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const moduleStatus: Record<ModuleKey, { status: string; label: string }> =
    aiConfigured === false ? { ...MODULE_STATUS, ai: { status: "planned", label: "needs API key" } } : MODULE_STATUS;
  const currentPhase = today ? PHASE_END.findIndex((end) => today <= end) : -1;

  const active = state.bookings.filter((b) => b.status === "confirmed").length;
  const conflicts = state.audit.filter((a) => a.outcome === "conflict").length;
  const failures = state.audit.filter((a) => a.action === "agent_failure").length;
  const verified = state.audit.filter((a) => a.outcome === "success").length;

  return (
    <div>
      <PageHeader
        kicker="FLOWOPS Agent Matrix"
        title="Command Center"
        description="Unified Operations Intelligence Platform — one view across FLOWOPS Core, FlowNet, FlowSec, FlowBiz, FlowAI, FlowConnect and FlowPulse."
      />

      <OnboardingChecklist />

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Booking Engine</h2>
        <LiveBadge label="Live · this browser" />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active bookings" value={active} tone="cyan" note="confirmed, not cancelled" />
        <Stat label="Verified pipeline runs" value={verified} tone="emerald" note="create · reschedule · cancel" />
        <Stat label="Conflicts caught" value={conflicts} tone="amber" note="Availability Agent" />
        <Stat label="Agent failures contained" value={failures} tone={failures ? "rose" : "slate"} note="rolled back + audited" />
      </div>

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Operations</h2>
        <SampleBadge />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {SAMPLE_OPS_KPIS.map((k) => (
          <div key={k.label} className="rounded-xl border border-dashed border-amber-400/20 bg-amber-400/[0.02] p-4">
            <p className="text-xs text-slate-400">{k.label}</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-slate-300">{k.value}</p>
            <p className="mt-1 text-[11px] text-amber-300/70">sample · {k.note}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Booking pipeline"
          subtitle="FLOWOPS CORE → Intent → Booking → Availability → Calendar → Notification → Audit → VERIFIED"
          action={
            <Link href="/booking" className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200">
              Open Booking Center <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          }
        >
          <PipelineView steps={idleSteps()} compact />
          <div className="mt-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Activity className="h-3.5 w-3.5" /> Recent audit activity
            </p>
            {state.audit.length === 0 ? (
              <p className="rounded-lg border border-white/[0.05] px-3 py-4 text-center text-xs text-slate-500">No activity yet — run a booking in the Booking Center.</p>
            ) : (
              <ul className="space-y-1">
                {state.audit.slice(0, 6).map((a) => (
                  <li key={a.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-white/[0.02]">
                    <span className="w-16 shrink-0 font-mono text-slate-600">{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <Pill status={a.outcome} />
                    <span className="truncate text-slate-400">{a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Phase 1 schedule" subtitle="Booking Engine program · 2026">
          <ol className="relative space-y-3 border-l border-white/[0.08] pl-4">
            {PHASES.map((p, i) => {
              const status = currentPhase === -1 ? "planned" : i < currentPhase ? "success" : i === currentPhase ? "running" : "planned";
              return (
                <li key={p.id} className="relative">
                  <span className={clsx("absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-[#0d1424]", status === "success" ? "bg-emerald-400" : status === "running" ? "bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)]" : "bg-slate-600")} />
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] text-slate-500">{p.id}</span>
                    <span className="text-sm text-slate-200">{p.title}</span>
                  </div>
                  <p className="font-mono text-[11px] text-slate-500">{p.dates}{status === "running" && " · current"}</p>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Platform modules</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(Object.keys(MODULES) as ModuleKey[]).map((k) => {
          const m = MODULES[k];
          return (
            <div key={k} className={clsx("rounded-xl border border-white/[0.07] bg-[#0d1424]/70 p-4 ring-1 ring-inset", m.ring)}>
              <div className="flex items-center gap-2">
                <span className={clsx("h-2 w-2 rounded-full", m.color)} />
                <p className={clsx("font-semibold", m.text)}>{m.name}</p>
                <span className="ml-auto">
                  <Pill status={moduleStatus[k].status}>{moduleStatus[k].label}</Pill>
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">{m.tagline}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
