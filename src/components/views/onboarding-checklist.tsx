"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useBookings, type Me } from "@/lib/booking/store";
import { clsx } from "../clsx";

/**
 * First-run checklist for the Owner of a new workspace. Steps are detected from real data where
 * possible (services, Google Calendar, team); "share booking link" and "name & hours" can be
 * ticked by hand. Progress + dismissal are remembered per workspace in this browser.
 */
type Saved = { dismissed?: boolean; shared?: boolean; basics?: boolean };
const keyFor = (orgId: string) => `flowops:onboarding:${orgId}`;
const DEFAULT_HOURS = JSON.stringify({ "0": null, "1": { open: "08:00", close: "18:00" }, "2": { open: "08:00", close: "18:00" }, "3": { open: "08:00", close: "18:00" }, "4": { open: "08:00", close: "18:00" }, "5": { open: "08:00", close: "18:00" }, "6": { open: "09:00", close: "14:00" } });

function load(orgId: string): Saved {
  try {
    return JSON.parse(localStorage.getItem(keyFor(orgId)) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

function hoursCustomized(me: Me) {
  const norm = Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, me.org.hours[d as "0"] ?? null]));
  return JSON.stringify(norm) !== DEFAULT_HOURS;
}

export function OnboardingChecklist() {
  const { me, state, hydrated } = useBookings();
  const [saved, setSaved] = useState<Saved | null>(null);
  const [copied, setCopied] = useState(false);
  const orgId = me?.org.id;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads browser storage after mount
    if (orgId) setSaved(load(orgId));
  }, [orgId]);

  if (!hydrated || !me || !saved || me.role !== "owner" || saved.dismissed) return null;
  // Only for new workspaces: under 30 days old, or nothing booked yet.
  const ageDays = me.org.createdAt ? (Date.parse(`${me.today.date}T12:00:00Z`) - Date.parse(me.org.createdAt)) / 86_400_000 : 0;
  if (ageDays > 30 && state.bookings.length > 0) return null;

  const update = (patch: Saved) => {
    const next = { ...saved, ...patch };
    setSaved(next);
    try {
      localStorage.setItem(keyFor(me.org.id), JSON.stringify(next));
    } catch {}
  };

  const link = typeof window !== "undefined" ? `${window.location.origin}/book/${me.org.slug}` : `/book/${me.org.slug}`;
  const named = !/'s workspace$/i.test(me.org.name);
  const steps = [
    {
      id: "basics",
      label: "Set your business name and hours",
      done: Boolean(saved.basics) || (named && hoursCustomized(me)),
      action: (
        <span className="flex items-center gap-2">
          <Link href="/admin#org" className="text-cyan-300 hover:underline">Edit</Link>
          <button type="button" onClick={() => update({ basics: true })} className="text-slate-400 hover:text-slate-200">Looks right</button>
        </span>
      ),
    },
    { id: "services", label: "Add the services customers can book", done: me.services.some((s) => s.active), action: <Link href="/admin#services" className="text-cyan-300 hover:underline">Add services</Link> },
    {
      id: "share",
      label: "Share your booking link",
      done: Boolean(saved.shared),
      action: (
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {}
            update({ shared: true });
          }}
          className="inline-flex items-center gap-1 text-cyan-300 hover:underline"
        >
          <Copy className="h-3 w-3" /> {copied ? "Copied" : "Copy link"}
        </button>
      ),
    },
    {
      id: "google",
      label: "Connect Google Calendar",
      done: me.org.googleConnected,
      action: <Link href="/admin#integrations" className="text-cyan-300 hover:underline">{me.integrations.googleCalendar ? "Connect" : "Set up"}</Link>,
    },
    { id: "team", label: "Invite your team (optional)", done: (me.team?.members ?? 1) > 1 || (me.team?.invites ?? 0) > 0, action: <Link href="/admin#team" className="text-cyan-300 hover:underline">Invite</Link> },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  return (
    <section aria-label="Getting started" data-testid="onboarding" className="mb-6 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.04] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Get {me.org.name} ready for bookings</h2>
          <p className="mt-0.5 text-xs text-slate-400">{doneCount} of {steps.length} done</p>
        </div>
        <button type="button" onClick={() => update({ dismissed: true })} className="rounded-md p-1 text-slate-500 hover:bg-white/5 hover:text-slate-300" aria-label="Dismiss getting-started checklist" title="Dismiss">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.id} data-step={s.id} data-done={s.done} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5">
            <span className={clsx("grid h-4 w-4 shrink-0 place-items-center rounded-full border", s.done ? "border-emerald-400 bg-emerald-400/20 text-emerald-300" : "border-slate-600")}>
              {s.done && <Check className="h-3 w-3" />}
            </span>
            <span className={clsx("flex-1", s.done ? "text-slate-500 line-through" : "text-slate-200")}>{s.label}</span>
            {!s.done && <span className="text-xs">{s.action}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
