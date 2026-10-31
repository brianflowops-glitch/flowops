"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Pill } from "../ui";
import { BILLING_SUPPORT_EMAIL } from "@/lib/billing/support";
import { planLabel, sortPlanKeys } from "@/lib/billing/entitlements";

type Interval = "month" | "year";
interface PlanState {
  plans: { key: string; interval: Interval }[];
  upgradePolicy: "at_renewal" | "prorate_now";
  supportEmail: string;
  demo: boolean;
  subscription: {
    status: string;
    plan: string | null;
    interval: Interval | null;
    trialEnd: string | null;
    periodEnd: string | null;
    cancelAt: string | null;
    hasAddons: boolean;
    hasSchedule: boolean;
  } | null;
  scheduled: { effectiveAt: string; plan: { from: string | null; to: string | null } | null; addons: { key: string; from: number; to: number }[] } | null;
}

const btn = "inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40";
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "");

/**
 * Billing on the Administration page (Owner/Admin): current plan, in-app plan switch (monthly and annual), cancel /
 * resume at period end, and the Stripe portal for the card and invoices only (plan switching is OFF in the portal).
 * Hidden when billing is off (the API answers 404). What the app can't do is sent to support.
 */
export function BillingCard() {
  const [state, setState] = useState<PlanState | null | "off">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; support?: boolean } | null>(null);
  const [interval, setBillingInterval] = useState<Interval>("month");

  const load = useCallback(async () => {
    const res = await fetch("/api/billing/plan").catch(() => null);
    if (!res || res.status === 404 || res.status === 403) return setState("off");
    const data = (await res.json().catch(() => null)) as PlanState | null;
    setState(data);
    if (data?.subscription?.interval) setBillingInterval(data.subscription.interval);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load of the billing state
    void load();
  }, [load]);

  async function post(url: string, body: unknown, key: string) {
    setBusy(key);
    setMsg(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg({ ok: false, text: data.error ?? `HTTP ${res.status}`, support: Boolean(data.support) });
      else setMsg({ ok: true, text: data.billing ?? "Done." });
      await load();
    } finally {
      setBusy(null);
    }
  }
  async function portal() {
    setBusy("portal");
    const res = await fetch("/api/billing/portal", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (data.url) window.location.assign(data.url);
    else {
      setMsg({ ok: false, text: data.error ?? "Couldn't open billing" });
      setBusy(null);
    }
  }

  if (state === "off") return null;
  if (!state) return <Card title="Billing"><p className="animate-pulse font-mono text-xs text-slate-500">loading…</p></Card>;
  const sub = state.subscription;
  const support = `mailto:${BILLING_SUPPORT_EMAIL}?subject=${encodeURIComponent("FlowOps billing")}`;
  const keys = sortPlanKeys(state.plans.map((p) => p.key));
  const hasAnnual = state.plans.some((p) => p.interval === "year");
  const isCurrent = (k: string) => sub?.plan === k && sub?.interval === interval;
  const disabled = busy !== null || state.demo || !sub || !!sub.cancelAt;

  return (
    <Card id="billing" title="Billing" subtitle="Plan, renewal and payment" className="mt-5">
      <div className="space-y-4 text-sm text-slate-300">
        {!sub ? (
          <p>No subscription yet.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-white">{sub.plan ? planLabel(sub.plan) : "Custom plan"}</span>
            <span className="text-slate-500">{sub.interval === "year" ? "yearly" : "monthly"}</span>
            <Pill status={sub.status === "active" || sub.status === "trialing" ? "active" : "pending"}>{sub.status}</Pill>
            {sub.trialEnd && <span className="text-xs text-slate-400">Free trial until {day(sub.trialEnd)}; nothing is charged before then.</span>}
            {!sub.trialEnd && sub.periodEnd && !sub.cancelAt && <span className="text-xs text-slate-400">Renews {day(sub.periodEnd)}</span>}
          </div>
        )}
        {sub?.cancelAt && <p className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-100">Ends on {day(sub.cancelAt)}. You keep access until then.</p>}
        {state.scheduled && (
          <p className="rounded-lg border border-cyan-400/30 bg-cyan-400/[0.06] px-3 py-2 text-xs text-cyan-100">
            At the next renewal ({day(state.scheduled.effectiveAt)}):{" "}
            {[state.scheduled.plan ? `plan changes to ${state.scheduled.plan.to ?? "another plan"}` : null, ...state.scheduled.addons.map((a) => `${a.key} ${a.from} → ${a.to}`)].filter(Boolean).join(", ")}
          </p>
        )}

        {sub && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">
              Change plan. {state.upgradePolicy === "prorate_now" ? "Upgrades (and monthly → yearly) apply now and are charged now, prorated." : "Upgrades apply at the next renewal."} Downgrades and yearly → monthly apply at the next renewal. During the free trial nothing is charged. Add-ons move with the plan.
            </p>
            {hasAnnual && (
              <div className="flex gap-2 text-xs">
                {(["month", "year"] as const).map((i) => (
                  <button key={i} type="button" aria-pressed={interval === i} onClick={() => setBillingInterval(i)} className={`rounded-full px-3 py-1 ${interval === i ? "bg-white/15 text-white" : "text-slate-400 hover:text-white"}`}>
                    {i === "month" ? "Monthly" : "Yearly"}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {keys.filter((k) => state.plans.some((p) => p.key === k && p.interval === interval)).map((k) => (
                <button key={k} className={btn} disabled={disabled || isCurrent(k)} onClick={() => post("/api/billing/plan", { plan: k, interval }, k)}>
                  {busy === k ? "Changing…" : isCurrent(k) ? `${planLabel(k)} (current)` : planLabel(k)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
          {/* Only with a subscription and never for the demo org: opening the portal creates a Stripe customer otherwise. */}
          {sub && !state.demo && <button className={btn} disabled={busy !== null} onClick={portal}>{busy === "portal" ? "Opening…" : "Card & invoices"}</button>}
          {sub && (sub.cancelAt ? (
            <button className={btn} disabled={busy !== null || state.demo} onClick={() => post("/api/billing/cancel", { cancel: false }, "resume")}>{busy === "resume" ? "Resuming…" : "Resume subscription"}</button>
          ) : (
            <button
              className={btn}
              disabled={busy !== null || state.demo}
              onClick={() => {
                if (window.confirm("Cancel at the end of the current period? You keep access until then; nothing is refunded.")) void post("/api/billing/cancel", { cancel: true }, "cancel");
              }}
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel at period end"}
            </button>
          ))}
        </div>
        {msg && (
          <p className={msg.ok ? "text-xs text-emerald-300" : "text-xs text-rose-300"}>
            {msg.text}
            {msg.support && (
              <>
                {" "}
                <a className="underline" href={support}>Contact support</a>
              </>
            )}
          </p>
        )}
        <p className="text-xs text-slate-500">
          The billing portal is for your card and invoices. Anything else (custom plans, discounts):{" "}
          <a className="text-cyan-300 hover:underline" href={support}>{BILLING_SUPPORT_EMAIL}</a>.
        </p>
      </div>
    </Card>
  );
}
