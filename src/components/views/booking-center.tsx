"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Play, Trash2, Wand2, XCircle } from "lucide-react";
import { useBookings } from "@/lib/booking/store";
import { PIPELINE } from "@/lib/booking/engine";
import type { AgentStep, BookingRequest, PipelineAgent, PipelineResult, ServiceCategory } from "@/lib/booking/types";
import { Card, LiveBadge, PageHeader, Pill, SimBadge, Table, Td } from "../ui";
import { PipelineView, idleSteps } from "../pipeline";
import { clsx } from "../clsx";

const CATEGORIES: { key: ServiceCategory; label: string; services: string[]; resources: string[] }[] = [
  { key: "appointment", label: "Appointments", services: ["Consultation", "Onboarding call", "Site survey", "Maintenance visit"], resources: ["Room A", "Room B", "Consultant — Dana"] },
  { key: "travel", label: "Travel", services: ["Airport transfer", "Client site visit", "Shuttle"], resources: ["Shuttle Van 1", "Car — Fleet 2"] },
  { key: "restaurant", label: "Restaurants", services: ["Team lunch", "Client dinner", "Breakfast meeting"], resources: ["Table 4 (4 seats)", "Table 7 (6 seats)", "Private Room"] },
  { key: "workforce", label: "Workforce", services: ["Technician dispatch", "Front-desk shift", "On-call cover"], resources: ["Technician — Alex", "Technician — Sam", "Front Desk"] },
];

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return ymd(d);
}

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10";

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx("block space-y-1", className)}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}

const CUSTOM = "__custom__";

export function BookingCenter() {
  const { state, me, create, reschedule, cancel, hydrated, error } = useBookings();
  const services = (me?.services ?? []).filter((s) => s.active);
  const [serviceId, setServiceId] = useState<string>("");
  const [form, setForm] = useState<BookingRequest>({
    customer: "",
    email: "",
    category: "appointment",
    service: "Consultation",
    resource: "Room A",
    date: "",
    time: "10:00",
    durationMin: 60,
  });
  const [fault, setFault] = useState<"" | PipelineAgent>("");
  const [steps, setSteps] = useState<AgentStep[]>(idleSteps);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [editing, setEditing] = useState<{ id: string; date: string; time: string } | null>(null);
  const [tab, setTab] = useState<"bookings" | "audit" | "notifications">("bookings");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- date depends on the client's clock
    setForm((f) => (f.date ? f : { ...f, date: tomorrow() }));
  }, []);

  const cat = CATEGORIES.find((c) => c.key === form.category)!;
  const custom = serviceId === CUSTOM || services.length === 0;

  function pickService(id: string) {
    setServiceId(id);
    const svc = services.find((s) => s.id === id);
    if (svc) setForm((f) => ({ ...f, category: svc.category, service: svc.name, resource: svc.resource, durationMin: svc.durationMin }));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- default to the first configured service once loaded
    if (!serviceId && services.length) pickService(services[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services.length]);
  const set = <K extends keyof BookingRequest>(k: K, v: BookingRequest[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function exec(fn: (opts: { stepDelayMs: number; onStep: (s: AgentStep[]) => void; failAgent?: PipelineAgent }) => Promise<PipelineResult>) {
    setRunning(true);
    setResult(null);
    const r = await fn({ stepDelayMs: 320, onStep: setSteps, failAgent: fault || undefined });
    setSteps(r.steps.map((s) => ({ ...s })));
    setResult(r);
    setRunning(false);
    return r;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await exec((o) => create(form, o));
    if (r.ok) setForm((f) => ({ ...f, customer: "", email: "", phone: "", notes: "" }));
  }

  async function seedDemo() {
    const day = tomorrow();
    const pick = services.slice(0, 3);
    const names = ["Demo — Acme Corp", "Demo — J. Rivera", "Demo — Field Ops"];
    const times = ["09:00", "11:00", "13:30"];
    const demo: BookingRequest[] = pick.map((s, i) => ({
      customer: names[i],
      email: `demo${i + 1}@example.com`,
      category: s.category,
      service: s.name,
      resource: s.resource,
      date: day,
      time: times[i],
      durationMin: s.durationMin,
      notes: "DEMO DATA",
    }));
    setRunning(true);
    for (const d of demo) {
      const r = await create(d, { stepDelayMs: 60, onStep: setSteps });
      setSteps(r.steps);
      setResult(r);
    }
    setRunning(false);
  }

  const confirmed = state.bookings.filter((b) => b.status === "confirmed").length;

  return (
    <div>
      <PageHeader
        kicker="FlowBiz · Booking Engine 4.0"
        title="Booking Center"
        description={`Every request runs the FLOWOPS booking pipeline on the server: Intent → Booking → Availability → Calendar → Notification → Audit. Bookings are saved in the database for ${me?.org.name ?? "your organization"}. ${me?.org.googleConnected && me.integrations.googleCalendar ? "Calendar: Google Calendar." : "Calendar: simulated."} ${me?.integrations.resendEmail ? "Email: Resend." : "Email: simulated."} ${me?.integrations.twilioSms ? "SMS: Twilio." : "SMS: simulated."}`}
      >
        <LiveBadge />
        <button onClick={seedDemo} disabled={running || services.length === 0} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-40">
          <Wand2 className="h-3.5 w-3.5" /> Add 3 demo bookings
        </button>
      </PageHeader>

      <div className="grid gap-5 xl:grid-cols-[380px_1fr]">
        <Card title="New booking request" subtitle="Submitted to FLOWOPS Core">
          <form onSubmit={submit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Customer">
                <input className={inputCls} value={form.customer} onChange={(e) => set("customer", e.target.value)} placeholder="Jane Doe" />
              </Field>
              <Field label="Recipient email">
                <input className={inputCls} value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="jane@example.com" />
              </Field>
            </div>
            <Field label="Phone (optional — SMS)">
              <input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} placeholder="+1 555 123 4567" />
            </Field>
            <Field label="Service">
              <select className={inputCls} value={custom ? CUSTOM : serviceId} onChange={(e) => pickService(e.target.value)}>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMin}m · {s.resource}
                  </option>
                ))}
                <option value={CUSTOM}>Custom…</option>
              </select>
            </Field>
            {custom && (
              <>
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-black/30 p-1">
              {CATEGORIES.map((c) => (
                <button
                  type="button"
                  key={c.key}
                  onClick={() => setForm((f) => ({ ...f, category: c.key, service: c.services[0], resource: c.resources[0] }))}
                  className={clsx("rounded-md px-1 py-1.5 text-[11px] font-medium transition", form.category === c.key ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400 hover:text-slate-200")}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <Field label="Service">
              <input className={inputCls} list="services" value={form.service} onChange={(e) => set("service", e.target.value)} />
              <datalist id="services">
                {cat.services.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="Resource">
              <select className={inputCls} value={form.resource} onChange={(e) => set("resource", e.target.value)}>
                {cat.resources.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </Field>
              </>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Field label="Date">
                <input type="date" className={inputCls} value={form.date} onChange={(e) => set("date", e.target.value)} />
              </Field>
              <Field label="Time">
                <input type="time" step={900} className={inputCls} value={form.time} onChange={(e) => set("time", e.target.value)} />
              </Field>
              <Field label="Minutes">
                <select className={inputCls} disabled={!custom} value={form.durationMin} onChange={(e) => set("durationMin", Number(e.target.value))}>
                  {Array.from(new Set([15, 30, 45, 60, 90, 120, 180, 240, form.durationMin])).sort((a, b) => a - b).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <details className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-xs text-slate-400">
              <summary className="cursor-pointer select-none">Fault injection (test agent failure handling)</summary>
              <div className="mt-2">
                <select className={inputCls} value={fault} onChange={(e) => setFault(e.target.value as PipelineAgent | "")}>
                  <option value="">None — normal run</option>
                  {PIPELINE.map((a) => (
                    <option key={a} value={a}>
                      Fail {a}
                    </option>
                  ))}
                </select>
              </div>
            </details>
            <button
              type="submit"
              disabled={running || !hydrated}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#04121a] transition hover:brightness-110 disabled:opacity-50"
            >
              <Play className="h-4 w-4" /> {running ? "Pipeline running…" : "Run booking pipeline"}
            </button>
          </form>
        </Card>

        <Card
          title="Agent pipeline"
          subtitle={result ? `${result.action} · ${result.outcome}` : running ? "running…" : "Idle — submit a request to watch each agent"}
          action={result && <Pill status={result.outcome} />}
        >
          <PipelineView steps={steps} verified={result ? result.verified : null} />
          {result && (
            <div
              className={clsx(
                "mt-4 rounded-lg border p-3 text-sm",
                result.ok ? "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100" : result.outcome === "conflict" || result.outcome === "invalid" ? "border-amber-400/30 bg-amber-400/[0.06] text-amber-100" : "border-rose-400/30 bg-rose-400/[0.06] text-rose-100",
              )}
            >
              {result.ok ? (
                <p>
                  <b>BOOKING VERIFIED</b> — {result.booking?.id} · {result.booking?.service} · {result.booking?.date} {result.booking?.time} · {result.booking?.resource}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="flex-1">
                    <b>{result.outcome.toUpperCase().replace("_", " ")}</b> — {result.error}
                    {result.outcome === "failed" && " No booking was saved; the failure is in the audit log."}
                  </p>
                  {result.suggestion && result.action === "create" && (
                    <button
                      onClick={() => {
                        setForm((f) => ({ ...f, date: result.suggestion!.date, time: result.suggestion!.time }));
                        setResult(null);
                        setSteps(idleSteps());
                      }}
                      className="rounded-md border border-amber-300/40 px-2.5 py-1 text-xs hover:bg-amber-300/10"
                    >
                      Use next free slot {result.suggestion.time}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card
        className="mt-5"
        title={
          <div className="flex gap-1">
            {(
              [
                ["bookings", `Bookings (${confirmed} active)`],
                ["audit", `Audit log (${state.audit.length})`],
                ["notifications", `Notifications (${state.notifications.length})`],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={clsx("rounded-md px-3 py-1 text-xs font-medium", tab === k ? "bg-white/[0.08] text-white" : "text-slate-400 hover:text-slate-200")}>
                {l}
              </button>
            ))}
          </div>
        }
        action={<span className="font-mono text-[10.5px] text-slate-500">{error ? `error: ${error}` : `saved in Postgres · ${me?.org.name ?? "…"}`}</span>}
      >
        {tab === "bookings" &&
          (state.bookings.length === 0 ? (
            <Empty text="No bookings yet. Submit a request above, or add demo bookings." />
          ) : (
            <Table head={["ID", "Customer", "Service", "Resource", "When", "Calendar", "Status", ""]}>
              {state.bookings.map((b) => (
                <tr key={b.id} className={b.status === "cancelled" ? "opacity-50" : ""}>
                  <Td className="font-mono text-xs text-cyan-300">
                    {b.id}
                    {state.sources?.[b.id] && <div className="text-[10px] uppercase text-slate-500">via {state.sources[b.id]}</div>}
                  </Td>
                  <Td>
                    <div className="text-slate-100">{b.customer}</div>
                    <div className="text-xs text-slate-500">{b.email}</div>
                    {b.phone && <div className="text-xs text-slate-500">{b.phone}</div>}
                  </Td>
                  <Td>
                    {b.service}
                    <div className="text-xs capitalize text-slate-500">{b.category}</div>
                  </Td>
                  <Td>{b.resource}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs">
                    {editing?.id === b.id ? (
                      <div className="flex flex-col gap-1">
                        <input type="date" className={inputCls} value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
                        <input type="time" step={900} className={inputCls} value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} />
                      </div>
                    ) : (
                      <>
                        {b.date} {b.time}
                        <div className="text-slate-500">{b.durationMin} min</div>
                      </>
                    )}
                  </Td>
                  <Td className="font-mono text-[11px] text-slate-500">
                    {b.calendarEventId ?? "—"}
                    {b.calendarEventId && (
                      <div className="mt-0.5">
                        {b.calendarEventId.startsWith("SIMCAL") ? <SimBadge /> : <Pill status="verified">google</Pill>}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Pill status={b.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {b.status === "confirmed" &&
                      (editing?.id === b.id ? (
                        <div className="flex justify-end gap-1">
                          <button
                            disabled={running}
                            onClick={async () => {
                              await exec((o) => reschedule(b.id, editing.date, editing.time, o));
                              setEditing(null);
                            }}
                            className="rounded-md bg-cyan-500/20 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/30"
                          >
                            Save
                          </button>
                          <button onClick={() => setEditing(null)} className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-white/5">
                            <XCircle className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <button title="Reschedule" disabled={running} onClick={() => setEditing({ id: b.id, date: b.date, time: b.time })} className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-cyan-300">
                            <CalendarClock className="h-4 w-4" />
                          </button>
                          <button
                            title="Cancel"
                            disabled={running}
                            onClick={() => {
                              if (confirm(`Cancel booking ${b.id} for ${b.customer}? The customer is notified.`)) void exec((o) => cancel(b.id, o));
                            }} className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-rose-300">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                  </Td>
                </tr>
              ))}
            </Table>
          ))}
        {tab === "audit" &&
          (state.audit.length === 0 ? (
            <Empty text="The Audit Agent records every action, conflict and failure here." />
          ) : (
            <Table head={["Time", "Action", "Booking", "Agent", "Outcome", "Detail", "By"]}>
              {state.audit.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap font-mono text-xs text-slate-500">{new Date(a.at).toLocaleString()}</Td>
                  <Td>
                    <Pill status={a.action === "agent_failure" ? "agent_failure" : "planned"}>{a.action.replace("_", " ")}</Pill>
                  </Td>
                  <Td className="font-mono text-xs text-cyan-300">{a.bookingId ?? "—"}</Td>
                  <Td className="text-xs">{a.agent}</Td>
                  <Td>
                    <Pill status={a.outcome} />
                  </Td>
                  <Td className="text-xs text-slate-400">{a.detail}</Td>
                  <Td className="text-xs text-slate-500">{a.actor ?? "—"}</Td>
                </tr>
              ))}
            </Table>
          ))}
        {tab === "notifications" &&
          (state.notifications.length === 0 ? (
            <Empty text="Notifications appear here. Channels marked (simulated) were not actually sent." />
          ) : (
            <Table head={["Time", "Booking", "Channel", "Recipient", "Subject", "Delivery"]}>
              {state.notifications.map((n) => (
                <tr key={n.id}>
                  <Td className="whitespace-nowrap font-mono text-xs text-slate-500">{new Date(n.at).toLocaleString()}</Td>
                  <Td className="font-mono text-xs text-cyan-300">{n.bookingId}</Td>
                  <Td className="text-xs">{n.channel}</Td>
                  <Td className="text-xs">{n.recipient}</Td>
                  <Td className="text-xs">{n.subject}</Td>
                  <Td>
                    <Pill status={n.deliveryStatus === "sent" ? "verified" : n.deliveryStatus === "failed" ? "failed" : "simulated"}>{n.deliveryStatus}</Pill>
                    {n.detail && <div className="mt-0.5 max-w-[16rem] truncate text-[10px] text-slate-500">{n.detail}</div>}
                  </Td>
                </tr>
              ))}
            </Table>
          ))}
      </Card>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-8 text-center text-sm text-slate-500">{text}</p>;
}
