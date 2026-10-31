"use client";

import { useEffect, useState } from "react";
import { CreditCard, ExternalLink, Save } from "lucide-react";
import type { ServiceRow } from "@/lib/booking/store";
import { formatCents, paymentDue, paymentLabel, servicePaymentError } from "@/lib/payments/rules";
import { Card } from "../ui";

type Status = { connected: boolean; accountId: string | null; chargesEnabled: boolean; detailsSubmitted: boolean; configured: boolean };
type Mode = NonNullable<ServiceRow["paymentMode"]>;

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none disabled:opacity-50";
const btn = "inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5 disabled:opacity-40";

const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const toDollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

/**
 * Settings → Payments at booking. Renders nothing unless the server has BOOKING_PAYMENTS_ENABLED=true (the status
 * endpoint 404s), so with the flag off the settings page is unchanged.
 */
export function PaymentsCard({ owner, services, onSaved }: { owner: boolean; services: ServiceRow[]; onSaved: () => Promise<void> }) {
  const [status, setStatus] = useState<Status | null | "off">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/payments", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()).payments as Status) : "off"))
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus("off"));
    return () => {
      live = false;
    };
  }, []);

  if (status === null || status === "off") return null;

  async function onboard() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/admin/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "onboard" }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.url) return window.location.assign(d.url);
    setBusy(false);
    setMsg({ ok: false, text: d.error ?? "Couldn't open Stripe." });
  }

  const ready = status.chargesEnabled;
  return (
    <Card
      id="payments"
      className="xl:col-span-2"
      title="Payments at booking"
      subtitle="Optionally take a deposit or the full price when customers book online. Payments go straight to your own Stripe account; the booking is confirmed once payment succeeds."
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
        <div className="text-sm">
          <CreditCard className="mr-1.5 inline h-4 w-4 text-slate-400" />
          {!status.connected
            ? "No Stripe account connected yet."
            : ready
              ? "Stripe connected — you can take payments."
              : "Stripe setup isn't finished yet. Bookings are taken without payment until it is."}
        </div>
        {owner && status.configured && (
          <button className={btn} disabled={busy} onClick={onboard}>
            <ExternalLink className="h-3.5 w-3.5" /> {!status.connected ? "Set up payments with Stripe" : ready ? "Update Stripe details" : "Finish Stripe setup"}
          </button>
        )}
      </div>
      {!status.configured && <p className="mt-2 text-xs text-amber-200">Payments aren&apos;t configured on the server yet.</p>}
      <div className="mt-4 space-y-2">
        {services.map((s) => (
          <ServicePaymentRow key={s.id} s={s} owner={owner} ready={ready} onSaved={onSaved} setMsg={setMsg} />
        ))}
      </div>
      <p className="mt-3 text-[11px] text-slate-500">
        Customers pay on a secure Stripe page; their time is held for 30 minutes while they pay. Refunds and disputes are handled in your Stripe dashboard. FlowOps
        takes no fee; Stripe&apos;s processing fees apply.
      </p>
      {msg && <p className={msg.ok ? "mt-2 text-xs text-emerald-300" : "mt-2 text-xs text-rose-300"}>{msg.text}</p>}
    </Card>
  );
}

function ServicePaymentRow({
  s,
  owner,
  ready,
  onSaved,
  setMsg,
}: {
  s: ServiceRow;
  owner: boolean;
  ready: boolean;
  onSaved: () => Promise<void>;
  setMsg: (m: { ok: boolean; text: string } | null) => void;
}) {
  const [mode, setMode] = useState<Mode>(s.paymentMode ?? "none");
  const [price, setPrice] = useState(toDollars(s.priceCents));
  const [deposit, setDeposit] = useState(toDollars(s.depositCents));
  const [percent, setPercent] = useState(s.depositPercent == null ? "" : String(s.depositPercent));
  const fields = { paymentMode: mode, priceCents: toCents(price), depositCents: toCents(deposit), depositPercent: percent.trim() === "" ? null : Number(percent) };
  const err = servicePaymentError(fields);
  const due = paymentDue(fields);

  async function save() {
    const r = await fetch(`/api/admin/services/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return setMsg({ ok: false, text: d.error ?? "Couldn't save." });
    await onSaved();
    setMsg({ ok: true, text: `Saved ${s.name}.` });
  }

  return (
    <div className="grid items-center gap-2 md:grid-cols-[1.4fr_1.2fr_100px_110px_auto]">
      <div className="text-sm text-slate-100">
        {s.name}
        <div className="text-xs text-slate-500">{mode === "none" ? "No payment at booking" : due ? paymentLabel(due) + (ready ? "" : " (once Stripe is set up)") : err}</div>
      </div>
      <select className={inputCls} disabled={!owner} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        <option value="none">No payment</option>
        <option value="fixed">Fixed deposit</option>
        <option value="percent">Percent deposit</option>
        <option value="full">Full price</option>
      </select>
      <input className={inputCls} disabled={!owner} inputMode="decimal" placeholder="Price $" aria-label="Price in dollars" value={price} onChange={(e) => setPrice(e.target.value)} />
      {mode === "percent" ? (
        <input className={inputCls} disabled={!owner} inputMode="numeric" placeholder="%" aria-label="Deposit percent" value={percent} onChange={(e) => setPercent(e.target.value)} />
      ) : (
        <input
          className={inputCls}
          disabled={!owner || mode !== "fixed"}
          inputMode="decimal"
          placeholder={mode === "fixed" ? "Deposit $" : "—"}
          aria-label="Deposit in dollars"
          value={mode === "fixed" ? deposit : ""}
          onChange={(e) => setDeposit(e.target.value)}
        />
      )}
      {owner && (
        <button className={btn} disabled={!!err} onClick={save} title={err ?? (due ? formatCents(due.amountCents) : "")}>
          <Save className="h-3.5 w-3.5" /> Save
        </button>
      )}
    </div>
  );
}
