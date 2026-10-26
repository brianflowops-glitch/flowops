import type { WeekHours } from "@/lib/db/schema";

export const DEMO_ORG_SLUG = "flowops-demo";
export const DEMO_ORG_ID = "org_flowops_demo";

/** Mon–Fri 08:00–18:00, Sat 09:00–14:00, Sun closed. */
export function defaultHours(): WeekHours {
  const wk = { open: "08:00", close: "18:00" };
  return { "0": null, "1": wk, "2": wk, "3": wk, "4": wk, "5": wk, "6": { open: "09:00", close: "14:00" } };
}

export const DEMO_SERVICES = [
  { id: "svc_demo_consult", name: "Consultation", category: "appointment", durationMin: 60, resource: "Room A", description: "One-hour consultation with the team." },
  { id: "svc_demo_onboard", name: "Onboarding call", category: "appointment", durationMin: 30, resource: "Room B", description: "30-minute onboarding call." },
  { id: "svc_demo_survey", name: "Site survey", category: "workforce", durationMin: 90, resource: "Technician — Alex", description: "On-site survey by a technician." },
  { id: "svc_demo_maint", name: "Maintenance visit", category: "workforce", durationMin: 60, resource: "Technician — Sam", description: "Scheduled maintenance visit." },
] as const;

export function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}
