import { clsx } from "./clsx";

export function Card({ className, children, title, action, subtitle }: { className?: string; children: React.ReactNode; title?: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={clsx("min-w-0 rounded-xl border border-white/[0.07] bg-[#0d1424]/80 shadow-[0_0_0_1px_rgba(255,255,255,0.01)] backdrop-blur", className)}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-wide text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, kicker, description, children }: { title: string; kicker?: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker && <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-cyan-400/80">{kicker}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-400">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function SampleBadge({ label = "Sample data — not connected" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      {label}
    </span>
  );
}

export function LiveBadge({ label = "Live · in-browser engine" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </span>
      {label}
    </span>
  );
}

export function SimBadge() {
  return <span className="rounded border border-violet-400/30 bg-violet-400/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-violet-300">simulated</span>;
}

const PILL: Record<string, string> = {
  success: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  active: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  confirmed: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  online: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  up: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  enforced: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  pass: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  verified: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  resolved: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30",
  running: "bg-cyan-400/10 text-cyan-300 border-cyan-400/30",
  next: "bg-cyan-400/10 text-cyan-300 border-cyan-400/30",
  investigating: "bg-cyan-400/10 text-cyan-300 border-cyan-400/30",
  "deploy-target": "bg-cyan-400/10 text-cyan-300 border-cyan-400/30",
  simulated: "bg-violet-400/10 text-violet-300 border-violet-400/30",
  pending: "bg-slate-400/10 text-slate-300 border-slate-400/20",
  planned: "bg-slate-400/10 text-slate-300 border-slate-400/20",
  draft: "bg-slate-400/10 text-slate-300 border-slate-400/20",
  design: "bg-slate-400/10 text-slate-300 border-slate-400/20",
  idea: "bg-slate-400/10 text-slate-300 border-slate-400/20",
  skipped: "bg-slate-400/10 text-slate-400 border-slate-400/20",
  cancelled: "bg-slate-400/10 text-slate-400 border-slate-400/20",
  monitor: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  degraded: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  medium: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  conflict: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  invalid: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  open: "bg-amber-400/10 text-amber-300 border-amber-400/30",
  low: "bg-sky-400/10 text-sky-300 border-sky-400/30",
  failed: "bg-rose-400/10 text-rose-300 border-rose-400/30",
  fail: "bg-rose-400/10 text-rose-300 border-rose-400/30",
  offline: "bg-rose-400/10 text-rose-300 border-rose-400/30",
  high: "bg-rose-400/10 text-rose-300 border-rose-400/30",
  agent_failure: "bg-rose-400/10 text-rose-300 border-rose-400/30",
  not_found: "bg-rose-400/10 text-rose-300 border-rose-400/30",
};

export function Pill({ status, children }: { status: string; children?: React.ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full border px-2 py-px font-mono text-[10.5px] uppercase tracking-wider", PILL[status] ?? PILL.pending)}>
      {children ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function Stat({ label, value, note, tone = "cyan" }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: "cyan" | "emerald" | "amber" | "rose" | "violet" | "slate" }) {
  const tones = {
    cyan: "from-cyan-400/20",
    emerald: "from-emerald-400/20",
    amber: "from-amber-400/20",
    rose: "from-rose-400/20",
    violet: "from-violet-400/20",
    slate: "from-slate-400/10",
  };
  return (
    <div className={clsx("relative overflow-hidden rounded-xl border border-white/[0.07] bg-gradient-to-br to-transparent p-4", tones[tone])}>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold text-white">{value}</p>
      {note && <p className="mt-1 text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-white/[0.06] text-[11px] uppercase tracking-wider text-slate-500">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04] text-slate-300">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={clsx("px-3 py-2 align-top", className)}>{children}</td>;
}
