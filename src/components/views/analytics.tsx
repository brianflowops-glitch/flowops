"use client";

import { useBookings } from "@/lib/booking/store";
import { Card, LiveBadge, PageHeader, SampleBadge } from "../ui";

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

const SAMPLE_SERIES = [12, 18, 15, 22, 28, 25, 31, 36, 33, 40, 44, 41];

export function Analytics() {
  const { state } = useBookings();
  const confirmed = state.bookings.filter((b) => b.status === "confirmed");
  const byCat = ["appointment", "travel", "restaurant", "workforce"].map((c) => ({ label: c, value: confirmed.filter((b) => b.category === c).length }));
  const byResource = Object.entries(
    confirmed.reduce<Record<string, number>>((acc, b) => ((acc[b.resource] = (acc[b.resource] ?? 0) + 1), acc), {}),
  ).map(([label, value]) => ({ label, value }));
  const outcomes = ["success", "conflict", "invalid", "failed", "not_found"].map((o) => ({ label: o.replace("_", " "), value: state.audit.filter((a) => a.outcome === o).length }));
  const max = Math.max(...SAMPLE_SERIES);

  return (
    <div>
      <PageHeader kicker="FlowPulse · Insights" title="Analytics" description="Booking analytics are computed live from the bookings in this browser. Platform-wide trends are sample data until telemetry is connected." />

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Booking Engine</h2>
        <LiveBadge label="Live · this browser" />
      </div>
      <div className="mb-8 grid gap-5 lg:grid-cols-3">
        <Card title="Active bookings by category">{confirmed.length ? <Bars data={byCat} /> : <EmptyNote />}</Card>
        <Card title="Utilisation by resource">{byResource.length ? <Bars data={byResource} color="bg-violet-400" /> : <EmptyNote />}</Card>
        <Card title="Pipeline outcomes (audit log)">{state.audit.length ? <Bars data={outcomes} color="bg-emerald-400" /> : <EmptyNote />}</Card>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Platform trends</h2>
        <SampleBadge />
      </div>
      <Card title="Automations executed per week" subtitle="Illustrative shape only — FlowPulse telemetry is not connected">
        <div className="flex h-44 items-end gap-2 border-b border-dashed border-amber-400/20 pb-1">
          {SAMPLE_SERIES.map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div className="w-full rounded-t bg-gradient-to-t from-amber-400/10 to-amber-400/40" style={{ height: `${(v / max) * 150}px` }} />
              <span className="font-mono text-[9px] text-slate-600">W{i + 1}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function EmptyNote() {
  return <p className="py-6 text-center text-xs text-slate-500">No data yet — create bookings in the Booking Center.</p>;
}
