"use client";

import { CheckCircle2, CircleDashed, Loader2, MinusCircle, XCircle, Cpu, BadgeCheck } from "lucide-react";
import { AGENT_ROLE, PIPELINE } from "@/lib/booking/engine";
import type { AgentStep } from "@/lib/booking/types";
import { clsx } from "./clsx";

const LABEL: Record<string, string> = {
  IntentAgent: "Intent",
  BookingAgent: "Booking",
  AvailabilityAgent: "Availability",
  CalendarAgent: "Calendar",
  NotificationAgent: "Notification",
  AuditAgent: "Audit",
};

function StepIcon({ status }: { status: AgentStep["status"] }) {
  if (status === "running") return <Loader2 className="h-4 w-4 animate-spin text-cyan-300" />;
  if (status === "success") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-rose-400" />;
  if (status === "skipped") return <MinusCircle className="h-4 w-4 text-slate-500" />;
  return <CircleDashed className="h-4 w-4 text-slate-600" />;
}

/** Idle placeholder. Calendar and email are live; each real run reports per step whether it was simulated (e.g. no calendar connected). */
export function idleSteps(): AgentStep[] {
  return PIPELINE.map((agent) => ({ agent, status: "pending", message: AGENT_ROLE[agent], simulated: false, durationMs: 0 }));
}

/** Visual FLOWOPS CORE → … → BOOKING VERIFIED chain. */
export function PipelineView({ steps, verified, compact }: { steps: AgentStep[]; verified?: boolean | null; compact?: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        <Node label="FLOWOPS CORE" icon={<Cpu className="h-4 w-4 text-cyan-300" />} tone="core" />
        {steps.map((s) => (
          <div key={s.agent} className="flex min-w-0 flex-1 items-stretch gap-1">
            <Connector active={s.status === "running" || s.status === "success"} />
            <Node
              label={LABEL[s.agent]}
              sub={s.simulated ? "simulated" : "agent"}
              icon={<StepIcon status={s.status} />}
              tone={s.status}
            />
          </div>
        ))}
        <Connector active={verified === true} />
        <Node
          label="VERIFIED"
          icon={<BadgeCheck className={clsx("h-4 w-4", verified ? "text-emerald-300" : verified === false ? "text-rose-400" : "text-slate-600")} />}
          tone={verified ? "success" : verified === false ? "failed" : "pending"}
        />
      </div>
      {!compact && (
        <ol className="space-y-1.5">
          {steps.map((s, i) => (
            <li key={s.agent} className={clsx("flex items-start gap-3 rounded-lg border px-3 py-2 text-sm transition", s.status === "running" ? "border-cyan-400/30 bg-cyan-400/[0.05]" : s.status === "failed" ? "border-rose-400/30 bg-rose-400/[0.05]" : "border-white/[0.05] bg-white/[0.015]")}>
              <span className="mt-0.5 font-mono text-[11px] text-slate-600">{String(i + 1).padStart(2, "0")}</span>
              <StepIcon status={s.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-100">{s.agent}</span>
                  {s.simulated && <span className="rounded border border-violet-400/30 bg-violet-400/10 px-1 font-mono text-[9.5px] uppercase text-violet-300">simulated</span>}
                </div>
                <p className={clsx("truncate text-xs", s.status === "failed" ? "text-rose-300" : "text-slate-400")} title={s.message}>
                  {s.message}
                </p>
              </div>
              {s.status === "success" && <span className="font-mono text-[10px] text-slate-600">{s.durationMs}ms</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Connector({ active }: { active: boolean }) {
  return (
    <svg width="12" height="44" className="shrink-0 self-center" viewBox="0 0 12 44">
      <line x1="0" y1="22" x2="12" y2="22" stroke={active ? "rgb(34,211,238)" : "rgba(148,163,184,0.25)"} strokeWidth="1.5" className={active ? "flow-dash" : undefined} />
    </svg>
  );
}

function Node({ label, sub, icon, tone }: { label: string; sub?: string; icon: React.ReactNode; tone: string }) {
  const tones: Record<string, string> = {
    core: "border-cyan-400/40 bg-cyan-400/[0.08]",
    running: "border-cyan-400/60 bg-cyan-400/[0.1] shadow-[0_0_20px_-6px_rgba(34,211,238,0.8)]",
    success: "border-emerald-400/40 bg-emerald-400/[0.07]",
    failed: "border-rose-400/50 bg-rose-400/[0.08]",
    skipped: "border-white/[0.06] bg-white/[0.01] opacity-60",
    pending: "border-white/[0.08] bg-white/[0.02]",
  };
  return (
    <div className={clsx("flex min-w-[66px] flex-1 flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2 text-center transition", tones[tone] ?? tones.pending)}>
      {icon}
      <span className="font-mono text-[10px] font-semibold uppercase text-slate-200">{label}</span>
      {sub && <span className={clsx("font-mono text-[9px] uppercase", sub === "simulated" ? "text-violet-300/80" : "text-slate-600")}>{sub}</span>}
    </div>
  );
}
