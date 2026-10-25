"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export const inputCls =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10 read-only:opacity-70";
export const primaryBtn =
  "w-full rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#04121a] hover:brightness-110 disabled:opacity-50";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#060a14] px-4 text-slate-200">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(34,211,238,0.08),transparent_45%),radial-gradient(ellipse_at_bottom_right,rgba(139,92,246,0.08),transparent_45%)]" />
      <div className="relative w-full max-w-sm rounded-2xl border border-white/[0.08] bg-[#080e1c]/90 p-6 shadow-2xl">
        <Link href="/" className="font-mono text-sm font-bold tracking-[0.18em] text-white">FLOWOPS</Link>
        <h1 className="mt-3 text-xl font-semibold text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export function ErrorNote({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="rounded-lg border border-rose-400/30 bg-rose-400/[0.07] px-3 py-2 text-sm text-rose-200">{text}</p>;
}
export function OkNote({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-emerald-400/30 bg-emerald-400/[0.07] px-3 py-2 text-sm text-emerald-100">{children}</p>;
}

export interface InviteInfo {
  token: string;
  email: string;
  orgName: string;
  role: "admin" | "staff";
}

function safeNext(fallback = "/") {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

export function AuthForm({ mode, invite }: { mode: "sign-in" | "sign-up"; invite?: InviteInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const email = invite ? invite.email : String(f.get("email") ?? "").trim();
    const password = String(f.get("password") ?? "");
    const res =
      mode === "sign-up"
        ? await authClient.signUp.email({
            email,
            password,
            name: String(f.get("name") ?? "").trim(),
            callbackURL: "/verify-email",
            ...(invite ? { inviteToken: invite.token } : { businessName: String(f.get("businessName") ?? "").trim() || undefined }),
          } as Parameters<typeof authClient.signUp.email>[0])
        : await authClient.signIn.email({ email, password, callbackURL: "/verify-email" });
    if (res.error) {
      setError(
        res.error.code === "EMAIL_NOT_VERIFIED"
          ? "Please verify your email first — we just sent you a new verification link."
          : (res.error.message ?? "Something went wrong"),
      );
      setBusy(false);
      return;
    }
    // REQUIRE_EMAIL_VERIFICATION on → sign-up returns no session until the email is verified.
    if (mode === "sign-up" && !(res.data as { token?: string | null } | null)?.token) {
      setCheckEmail(email);
      setBusy(false);
      return;
    }
    window.location.href = invite ? "/" : safeNext();
  }

  if (checkEmail)
    return (
      <AuthCard title="Check your email">
        <div className="mt-5 space-y-3">
          <OkNote>
            We sent a verification link to <span className="font-mono">{checkEmail}</span>. Open it to finish creating your account.
          </OkNote>
          <Link href="/sign-in" className="block text-center text-sm text-cyan-300 hover:underline">
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );

  const title = invite ? `Join ${invite.orgName}` : mode === "sign-up" ? "Create your account" : "Sign in";
  const subtitle = invite
    ? `You're invited as ${invite.role === "admin" ? "an Admin" : "Staff"}. Create your account to accept.`
    : mode === "sign-up"
      ? "The first account becomes the Owner of the workspace."
      : "Access the FLOWOPS dashboard.";

  return (
    <AuthCard title={title} subtitle={subtitle}>
      <form onSubmit={onSubmit} className="mt-5 space-y-3">
        {mode === "sign-up" && (
          <>
            <Field label="Your name">
              <input name="name" required autoComplete="name" className={inputCls} />
            </Field>
            {!invite && (
              <Field label="Business name (optional)">
                <input name="businessName" autoComplete="organization" className={inputCls} />
              </Field>
            )}
          </>
        )}
        <Field label="Email">
          {invite ? (
            <input name="email" type="email" readOnly value={invite.email} className={inputCls} />
          ) : (
            <input name="email" type="email" required autoComplete="email" className={inputCls} />
          )}
        </Field>
        <Field label="Password">
          <input
            name="password"
            type="password"
            required
            minLength={mode === "sign-up" ? 10 : undefined}
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            className={inputCls}
          />
        </Field>
        {mode === "sign-in" && (
          <p className="text-right text-xs">
            <Link href="/forgot-password" className="text-cyan-300 hover:underline">
              Forgot password?
            </Link>
          </p>
        )}
        <ErrorNote text={error} />
        {mode === "sign-up" && (
          <p className="text-xs leading-5 text-slate-500">
            By creating an account you agree to the{" "}
            <Link href="/terms" className="text-cyan-300 hover:underline">Terms of Service</Link> and{" "}
            <Link href="/privacy" className="text-cyan-300 hover:underline">Privacy Policy</Link>.
          </p>
        )}
        <button disabled={busy} className={primaryBtn}>
          {busy ? "Please wait…" : invite ? "Create account & join" : mode === "sign-up" ? "Create account" : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-slate-400">
        {invite ? (
          <>
            Already have an account?{" "}
            <Link href={`/sign-in?next=${encodeURIComponent(`/invite/${invite.token}`)}`} className="text-cyan-300 hover:underline">
              Sign in to accept
            </Link>
          </>
        ) : mode === "sign-up" ? (
          <>
            Already have an account? <Link href="/sign-in" className="text-cyan-300 hover:underline">Sign in</Link>
          </>
        ) : (
          <>
            New here? <Link href="/sign-up" className="text-cyan-300 hover:underline">Create an account</Link>
          </>
        )}
      </p>
    </AuthCard>
  );
}
