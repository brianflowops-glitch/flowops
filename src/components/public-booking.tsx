"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { CalendarCheck, CheckCircle2 } from "lucide-react";
import { clsx } from "./clsx";
import { SMS_CONSENT_TEXT, toE164 } from "@/lib/phone";

type Info = {
  org: { slug: string; name: string; timeZone: string; hours: Record<string, { open: string; close: string } | null> };
  services: { id: string; name: string; durationMin: number; description: string | null }[];
  today: { date: string; time: string };
};
type Done = { id: string; service: string; date: string; time: string; durationMin: number; notifications: string };

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function fmtDay(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
function fmtTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function PublicBooking() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<string[] | null>(null);
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    fetch(`/api/public/${encodeURIComponent(orgSlug)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("not found");
        const d: Info = await r.json();
        setInfo(d);
        setServiceId(d.services[0]?.id ?? "");
        // first open day from today
        for (let i = 0; i < 14; i++) {
          const day = addDays(d.today.date, i);
          const [y, m, dd] = day.split("-").map(Number);
          if (d.org.hours[String(new Date(Date.UTC(y, m - 1, dd)).getUTCDay())]) {
            setDate(day);
            break;
          }
        }
      })
      .catch(() => setNotFound(true));
  }, [orgSlug]);

  useEffect(() => {
    if (!serviceId || !date) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset while loading new availability
    setSlots(null);
    setTime("");
    fetch(`/api/public/${encodeURIComponent(orgSlug)}/availability?serviceId=${encodeURIComponent(serviceId)}&date=${date}`, { cache: "no-store" })
      .then(async (r) => ({ status: r.status, d: await r.json() }))
      .then(({ status, d }) => {
        if (!live) return;
        if (status === 429) setError(d.error ?? "Too many requests — please wait a moment.");
        setSlots(d.slots ?? []);
      })
      .catch(() => live && setSlots([]));
    return () => {
      live = false;
    };
  }, [orgSlug, serviceId, date]);

  const days = useMemo(() => (info ? Array.from({ length: 14 }, (_, i) => addDays(info.today.date, i)) : []), [info]);
  const service = info?.services.find((s) => s.id === serviceId);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!time) return setError("Please pick a time.");
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const smsConsent = f.get("smsConsent") === "on";
    if (smsConsent && !toE164(String(f.get("phone") ?? ""))) {
      setBusy(false);
      return setError("To get text updates, enter a valid US mobile number (e.g. 610-555-1234), or untick the text box.");
    }
    const res = await fetch(`/api/public/${encodeURIComponent(orgSlug)}/book`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId,
        date,
        time,
        name: f.get("name"),
        email: f.get("email"),
        phone: f.get("phone"),
        smsConsent,
        notes: f.get("notes") || undefined,
        website: f.get("website"),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (d.ok && d.booking) setDone({ ...d.booking, notifications: d.notifications });
    else {
      setError(d.error ?? "Booking failed — please try again.");
      if (res.status === 429) return; // rate limited: keep the chosen slot
      // refresh slots after a conflict
      setDate((x) => x);
      setSlots((s) => s?.filter((t) => t !== time) ?? null);
      setTime("");
    }
  }

  if (notFound)
    return (
      <Shell>
        <p className="text-center text-slate-400">This booking page doesn&apos;t exist or is turned off.</p>
      </Shell>
    );
  if (!info)
    return (
      <Shell>
        <p className="animate-pulse text-center font-mono text-xs text-slate-500">loading…</p>
      </Shell>
    );

  if (done)
    return (
      <Shell title={info.org.name}>
        <div className="text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
          <h2 className="mt-3 text-lg font-semibold text-white">You&apos;re booked!</h2>
          <p className="mt-1 text-sm text-slate-300">
            {done.service} · {fmtDay(done.date)} at {fmtTime(done.time)} ({done.durationMin} min)
          </p>
          <p className="mt-1 font-mono text-xs text-slate-500">Reference {done.id}</p>
          <p className="mt-3 text-xs text-slate-500">
            {done.notifications === "simulated"
              ? "Confirmation email is simulated in this beta — no email was sent. Keep your reference number."
              : "A confirmation has been sent to you."}
          </p>
          <button onClick={() => window.location.reload()} className="mt-5 rounded-lg border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5">
            Book another
          </button>
        </div>
      </Shell>
    );

  return (
    <Shell title={info.org.name}>
      {info.services.length === 0 ? (
        <p className="text-center text-sm text-slate-400">No services are available to book online yet.</p>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">1 · Service</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {info.services.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => setServiceId(s.id)}
                  className={clsx(
                    "rounded-lg border px-3 py-2 text-left text-sm transition",
                    s.id === serviceId ? "border-cyan-400/60 bg-cyan-400/10 text-white" : "border-white/10 text-slate-300 hover:border-white/20",
                  )}
                >
                  <span className="font-medium">{s.name}</span>
                  <span className="block text-xs text-slate-500">{s.durationMin} min{s.description ? ` · ${s.description}` : ""}</span>
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">2 · Date</h2>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {days.map((d) => {
                const [y, m, dd] = d.split("-").map(Number);
                const closed = !info.org.hours[String(new Date(Date.UTC(y, m - 1, dd)).getUTCDay())];
                return (
                  <button
                    type="button"
                    key={d}
                    disabled={closed}
                    onClick={() => setDate(d)}
                    className={clsx(
                      "shrink-0 rounded-lg border px-2.5 py-1.5 text-xs",
                      d === date ? "border-cyan-400/60 bg-cyan-400/10 text-white" : "border-white/10 text-slate-300 hover:border-white/20",
                      closed && "cursor-not-allowed opacity-30",
                    )}
                  >
                    {fmtDay(d)}
                  </button>
                );
              })}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              3 · Time <span className="normal-case text-slate-600">({info.org.timeZone})</span>
            </h2>
            {slots === null ? (
              <p className="animate-pulse text-xs text-slate-500">checking availability…</p>
            ) : slots.length === 0 ? (
              <p className="text-sm text-slate-400">No free times on this day{service ? ` for ${service.name}` : ""}. Try another date.</p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                {slots.map((t) => (
                  <button
                    type="button"
                    key={t}
                    onClick={() => setTime(t)}
                    className={clsx("rounded-md border px-2 py-1.5 text-xs", t === time ? "border-cyan-400/60 bg-cyan-400/15 text-white" : "border-white/10 text-slate-300 hover:border-white/20")}
                  >
                    {fmtTime(t)}
                  </button>
                ))}
              </div>
            )}
          </section>
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">4 · Your details</h2>
            <input name="name" required placeholder="Full name" autoComplete="name" className={inputCls} />
            <div className="grid gap-3 sm:grid-cols-2">
              <input name="email" type="email" required placeholder="Email" autoComplete="email" className={inputCls} />
              <input name="phone" type="tel" placeholder="Phone (optional)" autoComplete="tel" className={inputCls} />
            </div>
            <label className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
              <input name="smsConsent" type="checkbox" defaultChecked={false} className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-400" />
              <span>{SMS_CONSENT_TEXT}</span>
            </label>
            <textarea name="notes" rows={2} placeholder="Anything we should know? (optional)" className={inputCls} />
            <input name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />
          </section>
          {error && <p className="rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2 text-sm text-amber-100">{error}</p>}
          <button
            disabled={busy || !time}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#04121a] hover:brightness-110 disabled:opacity-40"
          >
            <CalendarCheck className="h-4 w-4" /> {busy ? "Booking…" : time ? `Book ${fmtDay(date)} at ${fmtTime(time)}` : "Pick a time"}
          </button>
          <p className="text-center text-[11px] text-slate-600">
            Hours: {DAYS.map((d, i) => (info.org.hours[String(i)] ? `${d} ${info.org.hours[String(i)]!.open}–${info.org.hours[String(i)]!.close}` : null)).filter(Boolean).join(" · ")}
          </p>
        </form>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#060a14] px-4 py-10 text-slate-200">
      <div className="mx-auto w-full max-w-xl rounded-2xl border border-white/[0.08] bg-[#080e1c]/90 p-6 shadow-2xl">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">Online booking</p>
        {title && <h1 className="mb-5 mt-1 text-2xl font-semibold text-white">{title}</h1>}
        {children}
      </div>
      <p className="mt-4 text-center font-mono text-[10px] tracking-[0.18em] text-slate-600">POWERED BY FLOWOPS</p>
    </div>
  );
}
