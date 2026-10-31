"use client";

import { useEffect, useState } from "react";

interface Trial {
  daysLeft: number;
  hasPaymentMethod: boolean;
  tone: "add_card" | "info";
  message: string;
}

/**
 * No-card free trial: "N days left, add a card" across the dashboard for Owner/Admin (GET /api/billing/trial).
 * Renders nothing when billing is off (404), for Staff (not mounted), outside a trial, or on any error.
 * The button deep-links into the Stripe portal's add-a-card flow.
 */
export function TrialBanner() {
  const [trial, setTrial] = useState<Trial | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/billing/trial")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { trial?: Trial | null } | null) => live && setTrial(d?.trial ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!trial) return null;
  const urgent = trial.tone === "add_card";

  async function addCard() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/billing/portal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flow: "payment_method_update" }) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (data.url) window.location.assign(data.url);
    else {
      setError(data.error ?? "Couldn't open billing. Try Administration → Billing.");
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="trial-banner"
      className={
        urgent
          ? "relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-cyan-400/25 bg-cyan-400/[0.07] px-4 py-2 text-xs text-cyan-50 lg:px-8"
          : "relative border-b border-white/[0.06] bg-white/[0.02] px-4 py-1.5 text-[11px] text-slate-400 lg:px-8"
      }
    >
      <span>{trial.message}</span>
      {urgent && (
        <button disabled={busy} onClick={addCard} className="rounded-md bg-cyan-400 px-2.5 py-1 font-semibold text-[#04121a] hover:brightness-110 disabled:opacity-50">
          {busy ? "Opening…" : "Add a card"}
        </button>
      )}
      {error && <span className="text-rose-300">{error}</span>}
    </div>
  );
}
