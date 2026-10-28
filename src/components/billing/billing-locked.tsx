"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import type { LockCopy } from "@/lib/billing/lock-copy";

/** Full-screen billing lock. Shown by the dashboard layout instead of the app when billing is locked. */
export function BillingLocked({ copy, orgName, planKeys, annualPlanKeys = [] }: { copy: LockCopy; orgName: string; planKeys: string[]; annualPlanKeys?: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<"month" | "year">("month");

  async function go(url: string, body?: unknown, key = url) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error ?? `Couldn't open billing (HTTP ${res.status})`);
      window.location.assign(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[#060a14] p-6 text-slate-300">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-white/[0.03] p-6 text-center">
        <p className="font-mono text-sm tracking-[0.18em] text-white">FLOWOPS</p>
        <p className="mt-1 text-xs text-slate-500">{orgName}</p>
        <h1 className="mt-5 text-lg font-semibold text-white">{copy.title}</h1>
        <p className="mt-2 text-sm leading-relaxed">{copy.message}</p>

        <div className="mt-6 flex flex-col gap-2">
          {copy.action === "portal" && (
            <button disabled={busy !== null} onClick={() => go("/api/billing/portal")} className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50">
              {busy ? "Opening billing…" : "Manage billing"}
            </button>
          )}
          {copy.action === "choose_plan" && annualPlanKeys.length > 0 && (
            <div className="flex justify-center gap-2 text-xs">
              {(["month", "year"] as const).map((i) => (
                <button key={i} type="button" aria-pressed={billingInterval === i} onClick={() => setBillingInterval(i)} className={`rounded-full px-3 py-1 ${billingInterval === i ? "bg-white/15 text-white" : "text-slate-400 hover:text-white"}`}>
                  {i === "month" ? "Monthly" : "Yearly (2 months free)"}
                </button>
              ))}
            </div>
          )}
          {copy.action === "choose_plan" &&
            (planKeys.length ? (
              planKeys.filter((k) => billingInterval === "month" || annualPlanKeys.includes(k)).map((k) => (
                <button key={k} disabled={busy !== null} onClick={() => go("/api/billing/checkout", { plan: k, interval: billingInterval }, k)} className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium capitalize text-slate-950 hover:bg-cyan-400 disabled:opacity-50">
                  {busy === k ? "Opening checkout…" : `Choose ${k}`}
                </button>
              ))
            ) : (
              <p className="text-xs text-slate-500">Plans aren&apos;t available yet. Please contact FlowOps support.</p>
            ))}
          {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
          <button
            disabled={busy !== null}
            onClick={async () => {
              await authClient.signOut();
              router.push("/sign-in");
              router.refresh();
            }}
            className="rounded-md px-4 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
