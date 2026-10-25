"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { AuthCard, ErrorNote, Field, OkNote, inputCls, primaryBtn } from "./auth-form";

/** Step 1: ask for a reset link. Same message whether or not the email has an account. */
export function ForgotPasswordForm() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AuthCard title="Reset your password" subtitle="Enter your account email and we'll send you a reset link.">
      {done ? (
        <div className="mt-5 space-y-3" data-testid="forgot-done">
          <OkNote>If an account exists for that email, a password reset link is on its way. It expires in 1 hour.</OkNote>
          <p className="text-xs text-slate-500">
            No email? If your business hasn&apos;t connected email yet, ask your Owner or Admin for a reset link from Administration → Team.
          </p>
          <Link href="/sign-in" className="block text-center text-sm text-cyan-300 hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form
          className="mt-5 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
            const r = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
            setBusy(false);
            // Only a rate limit is surfaced; everything else shows the same neutral message.
            if (r.error?.status === 429) return setError("Too many requests — wait a minute and try again.");
            setDone(true);
          }}
        >
          <Field label="Email">
            <input name="email" type="email" required autoComplete="email" className={inputCls} />
          </Field>
          <ErrorNote text={error} />
          <button disabled={busy} className={primaryBtn}>
            {busy ? "Please wait…" : "Send reset link"}
          </button>
          <Link href="/sign-in" className="block text-center text-sm text-slate-400 hover:text-cyan-300">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}

/** Step 2: choose a new password with the one-time token (?token=…). */
export function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token");
  const linkError = params.get("error");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token || linkError)
    return (
      <AuthCard title="Reset link not valid">
        <div className="mt-5 space-y-3">
          <ErrorNote text="This reset link is invalid, expired or was already used." />
          <Link href="/forgot-password" className="block text-center text-sm text-cyan-300 hover:underline">
            Request a new link
          </Link>
        </div>
      </AuthCard>
    );

  return (
    <AuthCard title="Choose a new password" subtitle="At least 10 characters. You'll be signed out on other devices.">
      {done ? (
        <div className="mt-5 space-y-3" data-testid="reset-done">
          <OkNote>Password updated. Sign in with your new password.</OkNote>
          <Link href="/sign-in" className="block text-center text-sm text-cyan-300 hover:underline">
            Sign in
          </Link>
        </div>
      ) : (
        <form
          className="mt-5 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const f = new FormData(e.currentTarget);
            const pw = String(f.get("password") ?? "");
            if (pw !== String(f.get("confirm") ?? "")) return setError("Passwords don't match.");
            setBusy(true);
            const r = await authClient.resetPassword({ newPassword: pw, token });
            setBusy(false);
            if (r.error)
              return setError(r.error.code === "INVALID_TOKEN" ? "This reset link is invalid, expired or was already used." : (r.error.message ?? "Couldn't reset the password."));
            setDone(true);
          }}
        >
          <Field label="New password">
            <input name="password" type="password" required minLength={10} autoComplete="new-password" className={inputCls} />
          </Field>
          <Field label="Confirm new password">
            <input name="confirm" type="password" required minLength={10} autoComplete="new-password" className={inputCls} />
          </Field>
          <ErrorNote text={error} />
          <button disabled={busy} className={primaryBtn}>
            {busy ? "Please wait…" : "Set new password"}
          </button>
        </form>
      )}
    </AuthCard>
  );
}

/** Landing page after the email-verification link (Better Auth redirects here, with ?error=… on failure). */
export function VerifyEmailView() {
  const params = useSearchParams();
  const error = params.get("error");
  return (
    <AuthCard title={error ? "Couldn't verify your email" : "Email verified"}>
      <div className="mt-5 space-y-3">
        {error ? (
          <ErrorNote text={error === "TOKEN_EXPIRED" ? "This verification link expired. Sign in and request a new one from the banner." : "This verification link is invalid or was already used."} />
        ) : (
          <OkNote>Thanks — your email address is confirmed.</OkNote>
        )}
        <Link href="/" className="block text-center text-sm text-cyan-300 hover:underline">
          Go to FlowOps
        </Link>
      </div>
    </AuthCard>
  );
}
