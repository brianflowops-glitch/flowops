"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { AuthCard, AuthForm, ErrorNote, OkNote, primaryBtn } from "./auth-form";

type Info = { status: "pending" | "accepted" | "revoked" | "expired" | "invalid"; orgName?: string; role?: "admin" | "staff"; email?: string };

const STATUS_TEXT: Record<Exclude<Info["status"], "pending">, string> = {
  accepted: "This invite was already used.",
  revoked: "This invite was revoked by the organization.",
  expired: "This invite expired. Ask the person who invited you to resend it.",
  invalid: "This invite link isn't valid.",
};

export function InviteAccept() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<Info | null>(null);
  const session = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    fetch(`/api/invites/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Info) => setInfo(d))
      .catch(() => setInfo({ status: "invalid" }));
  }, [token]);

  if (!info || session.isPending)
    return (
      <AuthCard title="Invitation">
        <p className="mt-4 animate-pulse font-mono text-xs text-slate-500">loading…</p>
      </AuthCard>
    );

  if (info.status !== "pending")
    return (
      <AuthCard title="Invitation" subtitle={info.orgName}>
        <div className="mt-5 space-y-3" data-testid="invite-status">
          <ErrorNote text={STATUS_TEXT[info.status]} />
          <Link href="/sign-in" className="block text-center text-sm text-cyan-300 hover:underline">
            Go to sign in
          </Link>
        </div>
      </AuthCard>
    );

  const user = session.data?.user;
  if (!user) return <AuthForm mode="sign-up" invite={{ token, email: info.email!, orgName: info.orgName!, role: info.role! }} />;

  const roleText = info.role === "admin" ? "an Admin" : "Staff";
  if (user.email.toLowerCase() !== info.email)
    return (
      <AuthCard title={`Join ${info.orgName}`}>
        <div className="mt-5 space-y-3">
          <ErrorNote text={`This invite is for ${info.email}, but you're signed in as ${user.email}.`} />
          <button
            className={primaryBtn}
            onClick={async () => {
              await authClient.signOut();
              window.location.reload();
            }}
          >
            Sign out and continue
          </button>
        </div>
      </AuthCard>
    );

  return (
    <AuthCard title={`Join ${info.orgName}`} subtitle={`You're invited as ${roleText}. Signed in as ${user.email}.`}>
      <div className="mt-5 space-y-3">
        {joined ? (
          <>
            <OkNote>You joined {info.orgName}.</OkNote>
            <button className={primaryBtn} onClick={() => {
                router.push("/");
                router.refresh();
              }}>
              Open FlowOps
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-slate-500">FlowOps accounts belong to one organization: accepting moves your account into {info.orgName}.</p>
            <ErrorNote text={error} />
            <button
              disabled={busy}
              className={primaryBtn}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const r = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
                const d = await r.json().catch(() => ({}));
                setBusy(false);
                if (!r.ok) return setError(d.error ?? `HTTP ${r.status}`);
                setJoined(true);
              }}
            >
              {busy ? "Please wait…" : `Accept and join as ${info.role === "admin" ? "Admin" : "Staff"}`}
            </button>
          </>
        )}
      </div>
    </AuthCard>
  );
}
