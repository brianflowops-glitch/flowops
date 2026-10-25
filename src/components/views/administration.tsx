"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Link2, Mail, MessageSquare, Plus, Save, Trash2, UserPlus } from "lucide-react";
import { useBookings, type ServiceRow } from "@/lib/booking/store";
import type { DayHours, WeekHoursClient } from "@/lib/booking/types";
import { Card, LiveBadge, PageHeader, Pill, Table, Td } from "../ui";
import { AdminPlans } from "./static-pages";

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none disabled:opacity-50";
const btn = "inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const CATS = ["appointment", "travel", "restaurant", "workforce"] as const;

async function api(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  if (!m) return null;
  return <p className={m.ok ? "text-xs text-emerald-300" : "text-xs text-rose-300"}>{m.text}</p>;
}

export function Administration() {
  const { me, refresh } = useBookings();
  const [googleNote, setGoogleNote] = useState<string | null>(null);

  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get("google");
    const notes: Record<string, string> = {
      connected: "Google Calendar connected. New bookings will create real calendar events.",
      "not-configured": "Google Calendar isn't configured on the server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).",
      denied: "Google access was denied.",
      "bad-state": "The Google connection link expired — try again.",
      "no-refresh-token": "Google didn't return a refresh token. Remove FlowOps from your Google account's third-party access and connect again.",
      error: "Google connection failed.",
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the OAuth redirect result once
    if (g) setGoogleNote(notes[g] ?? `Google: ${g}`);
  }, []);

  if (!me) return <p className="animate-pulse font-mono text-xs text-slate-500">loading…</p>;
  const owner = me.role === "owner";

  return (
    <div>
      <PageHeader
        kicker="FLOWOPS Core"
        title="Administration"
        description={`Settings for ${me.org.name}. Signed in as ${me.user.email} (${me.role}).${owner ? "" : " Only the Owner can change settings."}`}
      >
        <LiveBadge />
      </PageHeader>
      {googleNote && <p className="mb-4 rounded-lg border border-cyan-400/30 bg-cyan-400/[0.06] px-3 py-2 text-sm text-cyan-100">{googleNote}</p>}
      <div className="grid gap-5 xl:grid-cols-2">
        <OrgCard owner={owner} onSaved={refresh} />
        <HoursCard owner={owner} onSaved={refresh} />
        <ServicesCard owner={owner} services={me.services} onSaved={refresh} />
        <TeamCard owner={owner} />
        <IntegrationsCard owner={owner} onSaved={refresh} />
      </div>
      <AdminPlans />
    </div>
  );
}

function OrgCard({ owner, onSaved }: { owner: boolean; onSaved: () => Promise<void> }) {
  const { me } = useBookings();
  const [f, setF] = useState({ name: me!.org.name, slug: me!.org.slug, timeZone: me!.org.timeZone, publicBooking: me!.org.publicBooking });
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const link = typeof window === "undefined" ? `/book/${me!.org.slug}` : `${window.location.origin}/book/${me!.org.slug}`;
  return (
    <Card title="Organization" subtitle="Name, booking link and time zone">
      <div className="space-y-3">
        <label className="block space-y-1 text-xs text-slate-500">
          Business name
          <input disabled={!owner} className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1 text-xs text-slate-500">
            Booking link (/book/…)
            <input disabled={!owner} className={inputCls} value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} />
          </label>
          <label className="block space-y-1 text-xs text-slate-500">
            Time zone (IANA)
            <input disabled={!owner} className={inputCls} value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" disabled={!owner} checked={f.publicBooking} onChange={(e) => setF({ ...f, publicBooking: e.target.checked })} />
          Public booking page enabled
        </label>
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <Link2 className="h-3.5 w-3.5 text-cyan-300" />
          <a href={`/book/${me!.org.slug}`} target="_blank" className="text-cyan-300 hover:underline">
            {link}
          </a>
        </p>
        {owner && (
          <button
            className={btn}
            onClick={async () => {
              try {
                await api("/api/admin/org", "PATCH", f);
                await onSaved();
                setM({ ok: true, text: "Saved." });
              } catch (e) {
                setM({ ok: false, text: String((e as Error).message) });
              }
            }}
          >
            <Save className="h-3.5 w-3.5" /> Save
          </button>
        )}
        <Msg m={m} />
      </div>
    </Card>
  );
}

function HoursCard({ owner, onSaved }: { owner: boolean; onSaved: () => Promise<void> }) {
  const { me } = useBookings();
  const [h, setH] = useState<WeekHoursClient>(me!.org.hours);
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const setDay = (d: string, v: DayHours) => setH((x) => ({ ...x, [d]: v }));
  return (
    <Card title="Business hours" subtitle={`Bookings outside these hours are rejected (${me!.org.timeZone})`}>
      <div className="space-y-1.5">
        {DAYS.map((name, i) => {
          const k = String(i) as keyof WeekHoursClient;
          const v = h[k];
          return (
            <div key={k} className="grid grid-cols-[110px_80px_1fr_1fr] items-center gap-2 text-sm">
              <span className="text-slate-300">{name}</span>
              <label className="flex items-center gap-1.5 text-xs text-slate-400">
                <input type="checkbox" disabled={!owner} checked={!!v} onChange={(e) => setDay(k, e.target.checked ? { open: "09:00", close: "17:00" } : null)} />
                {v ? "open" : "closed"}
              </label>
              <input type="time" step={900} disabled={!owner || !v} className={inputCls} value={v?.open ?? ""} onChange={(e) => v && setDay(k, { ...v, open: e.target.value })} />
              <input type="time" step={900} disabled={!owner || !v} className={inputCls} value={v?.close ?? ""} onChange={(e) => v && setDay(k, { ...v, close: e.target.value })} />
            </div>
          );
        })}
        {owner && (
          <button
            className={`${btn} mt-2`}
            onClick={async () => {
              try {
                await api("/api/admin/org", "PATCH", { hours: h });
                await onSaved();
                setM({ ok: true, text: "Hours saved." });
              } catch (e) {
                setM({ ok: false, text: String((e as Error).message) });
              }
            }}
          >
            <Save className="h-3.5 w-3.5" /> Save hours
          </button>
        )}
        <Msg m={m} />
      </div>
    </Card>
  );
}

const blankService = { name: "", category: "appointment" as ServiceRow["category"], durationMin: 60, resource: "", description: "" };

function ServicesCard({ owner, services, onSaved }: { owner: boolean; services: ServiceRow[]; onSaved: () => Promise<void> }) {
  const [n, setN] = useState(blankService);
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await onSaved();
      setM({ ok: true, text: ok });
    } catch (e) {
      setM({ ok: false, text: String((e as Error).message) });
    }
  };
  return (
    <Card className="xl:col-span-2" title="Services" subtitle="What customers can book. Each service books one resource (room, person, vehicle…) — two bookings can't overlap on the same resource.">
      <Table head={["Service", "Category", "Minutes", "Resource", "Online", ""]}>
        {services.map((s) => (
          <tr key={s.id}>
            <Td>
              <div className="text-slate-100">{s.name}</div>
              {s.description && <div className="text-xs text-slate-500">{s.description}</div>}
            </Td>
            <Td className="text-xs capitalize">{s.category}</Td>
            <Td className="font-mono text-xs">{s.durationMin}</Td>
            <Td className="text-xs">{s.resource}</Td>
            <Td>
              <button
                disabled={!owner}
                onClick={() => act(() => api(`/api/admin/services/${s.id}`, "PATCH", { active: !s.active }), s.active ? "Hidden from booking." : "Bookable again.")}
              >
                <Pill status={s.active ? "active" : "cancelled"}>{s.active ? "bookable" : "hidden"}</Pill>
              </button>
            </Td>
            <Td className="text-right">
              {owner && (
                <button
                  title="Delete service"
                  className="rounded-md p-1.5 text-slate-400 hover:bg-white/5 hover:text-rose-300"
                  onClick={() => confirm(`Delete service "${s.name}"? Existing bookings are kept.`) && act(() => api(`/api/admin/services/${s.id}`, "DELETE"), "Service deleted.")}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {owner && (
        <form
          className="mt-4 grid gap-2 md:grid-cols-[1.4fr_1fr_90px_1.2fr_1.4fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("/api/admin/services", "POST", { ...n, sortOrder: services.length });
              setN(blankService);
            }, "Service added.");
          }}
        >
          <input required placeholder="Service name" className={inputCls} value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} />
          <select className={inputCls} value={n.category} onChange={(e) => setN({ ...n, category: e.target.value as ServiceRow["category"] })}>
            {CATS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input type="number" min={15} max={480} step={15} className={inputCls} value={n.durationMin} onChange={(e) => setN({ ...n, durationMin: Number(e.target.value) })} />
          <input required placeholder="Resource (e.g. Room A)" className={inputCls} value={n.resource} onChange={(e) => setN({ ...n, resource: e.target.value })} />
          <input placeholder="Description (optional)" className={inputCls} value={n.description} onChange={(e) => setN({ ...n, description: e.target.value })} />
          <button className={btn}>
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </form>
      )}
      <div className="mt-2">
        <Msg m={m} />
      </div>
    </Card>
  );
}

type Team = { members: { id: string; role: string; name: string; email: string; userId: string }[]; invites: { id: string; email: string }[]; me: string };

function TeamCard({ owner }: { owner: boolean }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [email, setEmail] = useState("");
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api("/api/admin/staff", "GET").then(setTeam).catch(() => setTeam(null)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await load();
      setM({ ok: true, text: ok });
    } catch (e) {
      setM({ ok: false, text: String((e as Error).message) });
    }
  };
  return (
    <Card title="Team" subtitle="Owner + Staff. Customers don't need accounts.">
      <ul className="space-y-1.5">
        {team?.members.map((u) => (
          <li key={u.id} className="flex items-center gap-2 rounded-lg border border-white/[0.05] px-3 py-2 text-sm">
            <span className="text-slate-100">{u.name}</span>
            <span className="font-mono text-xs text-slate-500">{u.email}</span>
            <span className="ml-auto">
              <Pill status={u.role === "owner" ? "verified" : "planned"}>{u.role}</Pill>
            </span>
            {owner && u.role !== "owner" && (
              <button
                title="Remove staff member"
                className="rounded-md p-1 text-slate-400 hover:text-rose-300"
                onClick={() => confirm(`Remove ${u.email}? Their login is deleted.`) && act(() => api("/api/admin/staff", "DELETE", { memberId: u.id }), "Removed.")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
        {team?.invites.map((i) => (
          <li key={i.id} className="flex items-center gap-2 rounded-lg border border-dashed border-white/10 px-3 py-2 text-sm text-slate-400">
            <span className="font-mono text-xs">{i.email}</span>
            <span className="ml-auto text-xs">invited · signs up at /sign-up</span>
            {owner && (
              <button className="rounded-md p-1 text-slate-400 hover:text-rose-300" onClick={() => act(() => api("/api/admin/staff", "DELETE", { inviteId: i.id }), "Invite removed.")}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("/api/admin/staff", "POST", { email });
              setEmail("");
            }, "Invite saved. Ask them to create an account at /sign-up with this email (no email is sent automatically).");
          }}
        >
          <input type="email" required placeholder="staff@example.com" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className={btn}>
            <UserPlus className="h-3.5 w-3.5" /> Invite staff
          </button>
        </form>
      )}
      <div className="mt-2">
        <Msg m={m} />
      </div>
    </Card>
  );
}

function IntegrationsCard({ owner, onSaved }: { owner: boolean; onSaved: () => Promise<void> }) {
  const { me } = useBookings();
  const i = me!.integrations;
  const [m, setM] = useState<{ ok: boolean; text: string } | null>(null);
  const row = (icon: React.ReactNode, name: string, live: boolean, liveText: string, simText: string, extra?: React.ReactNode) => (
    <li className="rounded-lg border border-white/[0.05] px-3 py-2.5">
      <div className="flex items-center gap-2 text-sm text-slate-100">
        {icon} {name}
        <span className="ml-auto">
          <Pill status={live ? "verified" : "simulated"}>{live ? "live" : "simulated"}</Pill>
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">{live ? liveText : simText}</p>
      {extra}
    </li>
  );
  return (
    <Card title="Integrations" subtitle="Each one turns on when its credentials are set on the server; until then the pipeline step stays simulated.">
      <ul className="space-y-2">
        {row(
          <CalendarDays className="h-4 w-4 text-cyan-300" />,
          "Google Calendar",
          i.googleCalendar && me!.org.googleConnected,
          `Connected as ${me!.org.googleAccountEmail ?? "Google account"} — bookings create real events.`,
          i.googleCalendar ? "App is configured — connect your Google account to turn it on." : "Not configured: needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.",
          owner && i.googleCalendar ? (
            <div className="mt-2 flex gap-2">
              {me!.org.googleConnected ? (
                <button
                  className={btn}
                  onClick={async () => {
                    if (!confirm("Disconnect Google Calendar? New bookings go back to simulated events.")) return;
                    await api("/api/integrations/google/disconnect", "POST").catch((e) => setM({ ok: false, text: String(e.message) }));
                    await onSaved();
                  }}
                >
                  Disconnect
                </button>
              ) : (
                <a className={btn} href="/api/integrations/google/connect">
                  Connect Google Calendar
                </a>
              )}
            </div>
          ) : null,
        )}
        {row(
          <Mail className="h-4 w-4 text-cyan-300" />,
          "Email (Resend)",
          i.resendEmail,
          i.resendFrom ? "Confirmation emails are sent for real." : "Live, but RESEND_FROM_EMAIL isn't set — using Resend's test sender (only delivers to your Resend account email).",
          "Not configured: needs RESEND_API_KEY (+ RESEND_FROM_EMAIL on a verified domain). Emails are logged as simulated.",
        )}
        {row(
          <MessageSquare className="h-4 w-4 text-cyan-300" />,
          "SMS (Twilio)",
          i.twilioSms,
          "Text confirmations are sent when the customer gives a phone number.",
          "Not configured: needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER. SMS is logged as simulated.",
        )}
      </ul>
      <div className="mt-2">
        <Msg m={m} />
      </div>
    </Card>
  );
}
