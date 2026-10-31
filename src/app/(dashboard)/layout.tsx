import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/server/context";
import { hasDatabase } from "@/lib/db";
import { resendConfigured } from "@/lib/server/integrations/notify";
import { getBillingAccess } from "@/lib/billing/access";
import { plans, trialDays } from "@/lib/billing/config";
import { lockScreenCopy } from "@/lib/billing/lock-copy";
import { planPicker } from "@/lib/billing/entitlements";
import { BillingLocked } from "@/components/billing/billing-locked";

async function Gate({ children }: { children: React.ReactNode }) {
  if (!hasDatabase()) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#060a14] p-6 text-center text-slate-300">
        <div>
          <p className="font-mono text-sm tracking-[0.18em] text-white">FLOWOPS</p>
          <p className="mt-2 text-sm">Database not configured (DATABASE_URL is missing).</p>
        </div>
      </div>
    );
  }
  const ctx = await getContext();
  if (!ctx) redirect("/sign-in");
  // Failed card / no active plan → lock screen instead of the app (no-op while BILLING_ENABLED is off;
  // exempt and is_demo orgs always pass, see getBillingAccess).
  const access = await getBillingAccess(ctx.org, ctx.role);
  if (access.access === "locked") {
    // Plan keys only (never price ids) and only for people who can act on them.
    const all = access.canManageBilling ? plans() : [];
    // Tier order (Solo, Starter, Pro, Business). A plan whose STRIPE_PRICE_* is unset is simply not listed.
    const { planKeys, annualPlanKeys, planNotes } = planPicker(all);
    return <BillingLocked copy={lockScreenCopy(access, { trialDays: trialDays() })} orgName={ctx.org.name} planKeys={planKeys} annualPlanKeys={annualPlanKeys} planNotes={planNotes} />;
  }
  return (
    <AppShell
      session={{
        name: ctx.user.name,
        email: ctx.user.email,
        role: ctx.role,
        orgName: ctx.org.name,
        orgSlug: ctx.org.slug,
        emailVerified: ctx.user.emailVerified,
        emailLive: resendConfigured(),
      }}
    >
      {children}
    </AppShell>
  );
}

function ShellFallback() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#060a14]">
      <p className="animate-pulse font-mono text-xs tracking-[0.18em] text-slate-500">FLOWOPS · loading…</p>
    </div>
  );
}

export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<ShellFallback />}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}
