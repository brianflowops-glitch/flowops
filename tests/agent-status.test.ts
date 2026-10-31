import { describe, expect, it } from "vitest";
import { AGENTS } from "@/lib/data/platform";
import { INTEGRATIONS } from "@/lib/data/integrations";

const byName = (n: string) => AGENTS.find((a) => a.name === n)!;

describe("Agent Matrix statuses match what is live", () => {
  it("booking pipeline agents, Calendar and Notification are active", () => {
    for (const n of ["IntentAgent", "BookingAgent", "AvailabilityAgent", "CalendarAgent", "NotificationAgent", "AuditAgent"]) {
      expect(byName(n).status, n).toBe("active");
    }
  });

  it("no agent is still labelled simulated", () => {
    expect(AGENTS.filter((a) => a.status === "simulated")).toEqual([]);
    expect(AGENTS.filter((a) => /simulated/i.test(a.role))).toEqual([]);
  });

  it("NotificationAgent says SMS is pending carrier approval", () => {
    expect(byName("NotificationAgent").role).toMatch(/SMS.*carrier approval/i);
  });

  it("BizAgent stays planned but says booking already runs", () => {
    const biz = byName("BizAgent");
    expect(biz.status).toBe("planned");
    expect(biz.role).toMatch(/bookings already run/i);
  });

  it("Integrations list shows Google Calendar and email as live, SMS as up next", () => {
    const status = (n: string) => INTEGRATIONS.find((i) => i.name === n)?.status;
    expect(status("Google Calendar")).toBe("live");
    expect(status("Resend email")).toBe("live");
    expect(status("Twilio SMS")).toBe("next");
  });
});
