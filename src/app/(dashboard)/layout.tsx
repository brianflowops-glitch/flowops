import { Suspense } from "react";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/server/context";
import { hasDatabase } from "@/lib/db";
import { resendConfigured } from "@/lib/server/integrations/notify";

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
