"use client";

import { useEffect, useState } from "react";
import { useBookings } from "@/lib/booking/store";
import { Card, LiveBadge, PageHeader } from "../ui";

interface AutomationWeek {
  weekStart: string;
  bookingRuns: number;
  reminders: number;
  total: number;
}
interface AutomationTrend {
  timeZone: string;
  weeks: AutomationWeek[];
  total: number;
}

function Bars({ data, color = "bg-cyan-400" }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2.5">
      {data.map((d) => (
        <li key={d.label} className="text-xs">
          <div className="mb-1 flex justify-between text-slate-400">
            <span className="capitalize">{d.label}</span>
            <span className="font-mono text-slate-300">{d.value}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.05]">
            <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${(d.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Analytics() {
  const { state } = useBookings();
  const confirmed = state.bookings.filter((b) => b.status === "confirmed");
  const byCat = ["appointment", "travel", "restaurant", "workforce"].map((c) => ({ label: c, value: confirmed.filter((b) => b.category === c).length }));
  const byResource = Object.entries(
    confirmed.reduce<Record<string, number>>((acc, b) => ((acc[b.resource] = (acc[b.resource] ?? 0) + 1), acc), {}),
  ).map(([label, value]) => ({ label, value }));
  const outcomes = ["success", "conflict", "invalid", "failed", "not_found"].map((o) => ({ label: o.replace("_", " "), value: state.audit.filter((a) => a.outcome === o).length }));

  return (
    <div>
      <PageHeader kicker="FlowPulse · Insights" title="Analytics" description="Computed live from your organization's bookings, audit log and reminders." />

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Booking Engine</h2>
        <LiveBadge label="Live" />
      </div>
      <div className="mb-8 grid gap-5 lg:grid-cols-3">
        <Card title="Active bookings by category">{confirmed.length ? <Bars data={byCat} /> : <EmptyNote />}</Card>
        <Card title="Utilisation by resource">{byResource.length ? <Bars data={byResource} color="bg-violet-400" /> : <EmptyNote />}</Card>
        <Card title="Pipeline outcomes (audit log)">{state.audit.length ? <Bars data={outcomes} color="bg-emerald-400" /> : <EmptyNote />}</Card>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Platform trends</h2>
        <LiveBadge label="Live · last 12 weeks" />
      </div>
      <AutomationsPerWeek refreshKey={state.audit.length + state.notifications.length} />
    </div>
  );
}

const shortWeek = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function AutomationsPerWeek({ refreshKey }: { refreshKey: number }) {
  const [trend, setTrend] = useState<AutomationTrend | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/analytics/automations", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        return data as AutomationTrend;
      })
      .then((t) => {
        if (cancelled) return;
        setTrend(t);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const subtitle = "Completed booking workflows (create, reschedule, cancel) and appointment reminders sent, by week";
  if (error && !trend) {
    return (
      <Card title="Automations executed per week" subtitle={subtitle}>
        <p className="py-6 text-center text-xs text-rose-300">Couldn&apos;t load automation counts: {error}</p>
      </Card>
    );
  }
  if (!trend) {
    return (
      <Card title="Automations executed per week" subtitle={subtitle}>
        <p className="py-6 text-center text-xs text-slate-500">Loading…</p>
      </Card>
    );
  }
  if (trend.total === 0) {
    return (
      <Card title="Automations executed per week" subtitle={subtitle}>
        <p className="py-10 text-center text-sm text-slate-400">No automations yet</p>
        <p className="-mt-8 pb-4 text-center text-xs text-slate-500">They&apos;ll appear here as bookings run and reminders go out.</p>
      </Card>
    );
  }

  const max = Math.max(1, ...trend.weeks.map((w) => w.total));
  return (
    <Card
      title="Automations executed per week"
      subtitle={subtitle}
      action={<span className="font-mono text-xs text-slate-400">{trend.total} total</span>}
    >
      <div className="flex h-44 items-end gap-2 border-b border-white/[0.08] pb-1">
        {trend.weeks.map((w) => (
          <div
            key={w.weekStart}
            className="flex flex-1 flex-col items-center gap-1"
            title={`Week of ${shortWeek(w.weekStart)}: ${w.bookingRuns} booking workflow${w.bookingRuns === 1 ? "" : "s"}, ${w.reminders} reminder${w.reminders === 1 ? "" : "s"}`}
          >
            <span className="font-mono text-[9px] text-slate-400">{w.total || ""}</span>
            <div className="flex w-full flex-col justify-end overflow-hidden rounded-t" style={{ height: `${(w.total / max) * 130}px` }}>
              {w.reminders > 0 && <div className="w-full bg-violet-400/60" style={{ height: `${(w.reminders / w.total) * 100}%` }} />}
              {w.bookingRuns > 0 && <div className="w-full bg-cyan-400/60" style={{ height: `${(w.bookingRuns / w.total) * 100}%` }} />}
            </div>
            <span className="font-mono text-[9px] text-slate-600">{shortWeek(w.weekStart)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-cyan-400/60" />Booking workflows</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-violet-400/60" />Reminders sent</span>
        <span className="ml-auto text-slate-500">Weeks start Monday · {trend.timeZone}</span>
      </div>
    </Card>
  );
}

function EmptyNote() {
  return <p className="py-6 text-center text-xs text-slate-500">No data yet — create bookings in the Booking Center.</p>;
}
