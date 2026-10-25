"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "").trim();
    const password = String(f.get("password") ?? "");
    const res =
      mode === "sign-up"
        ? await authClient.signUp.email({
            email,
            password,
            name: String(f.get("name") ?? "").trim(),
            businessName: String(f.get("businessName") ?? "").trim() || undefined,
          } as Parameters<typeof authClient.signUp.email>[0])
        : await authClient.signIn.email({ email, password });
    if (res.error) {
      setError(res.error.message ?? "Something went wrong");
      setBusy(false);
      return;
    }
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[#060a14] px-4 text-slate-200">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(34,211,238,0.08),transparent_45%),radial-gradient(ellipse_at_bottom_right,rgba(139,92,246,0.08),transparent_45%)]" />
      <div className="relative w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#080e1c]/90 p-6 shadow-2xl">
        <p className="font-mono text-sm font-bold tracking-[0.18em] text-white">FLOWOPS</p>
        <h1 className="mt-3 text-xl font-semibold text-white">{mode === "sign-up" ? "Create your account" : "Sign in"}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {mode === "sign-up" ? "The first account becomes the Owner of the workspace." : "Access the FLOWOPS dashboard."}
        </p>
        <form onSubmit={onSubmit} className="mt-5 space-y-3">
          {mode === "sign-up" && (
            <>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Your name</span>
                <input name="name" required autoComplete="name" className={inputCls} />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Business name (optional)</span>
                <input name="businessName" autoComplete="organization" className={inputCls} />
              </label>
            </>
          )}
          <label className="block space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Email</span>
            <input name="email" type="email" required autoComplete="email" className={inputCls} />
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={mode === "sign-up" ? 10 : undefined}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              className={inputCls}
            />
          </label>
          {error && <p className="rounded-lg border border-rose-400/30 bg-rose-400/[0.07] px-3 py-2 text-sm text-rose-200">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#04121a] hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Please wait…" : mode === "sign-up" ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-400">
          {mode === "sign-up" ? (
            <>
              Already have an account? <Link href="/sign-in" className="text-cyan-300 hover:underline">Sign in</Link>
            </>
          ) : (
            <>
              New here? <Link href="/sign-up" className="text-cyan-300 hover:underline">Create an account</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
