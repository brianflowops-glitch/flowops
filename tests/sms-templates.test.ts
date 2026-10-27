import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatSmsWhen, smsBodyFor, smsKindFromSubject, smsText } from "@/lib/notify/sms-templates";

/** Customer texts must match the A2P campaign samples word for word. */
describe("SMS templates match the A2P campaign samples", () => {
  const biz = "Business Name";

  it("confirmation", () => {
    expect(smsText("confirmed", { date: "2026-10-27", time: "10:00" }, biz)).toBe(
      "FlowOps: Your appointment with Business Name is confirmed for Tue Oct 27 at 10:00 AM. Reply STOP to opt out, HELP for help.",
    );
  });
  it("reschedule", () => {
    expect(smsText("rescheduled", { date: "2026-10-28", time: "14:00" }, biz)).toBe(
      "FlowOps: Your appointment with Business Name has been rescheduled to Wed Oct 28 at 2:00 PM. Reply STOP to opt out, HELP for help.",
    );
  });
  it("cancellation", () => {
    expect(smsText("cancelled", { date: "2026-10-27", time: "10:00" }, biz)).toBe(
      "FlowOps: Your appointment with Business Name on Tue Oct 27 at 10:00 AM has been cancelled. Reply STOP to opt out, HELP for help.",
    );
  });

  it("formats business-local wall time without shifting it", () => {
    expect(formatSmsWhen("2026-10-27", "00:05")).toBe("Tue Oct 27 at 12:05 AM");
    expect(formatSmsWhen("2026-10-27", "12:30")).toBe("Tue Oct 27 at 12:30 PM");
    expect(formatSmsWhen("2026-11-01", "23:45")).toBe("Sun Nov 1 at 11:45 PM");
    expect(formatSmsWhen("2027-01-04", "09:00")).toBe("Mon Jan 4 at 9:00 AM");
  });

  it("maps the engine's subjects to the right message", () => {
    expect(smsKindFromSubject("Booking confirmed: Haircut on 2026-10-27 at 10:00")).toBe("confirmed");
    expect(smsKindFromSubject("Booking rescheduled: Haircut now 2026-10-28 at 14:00")).toBe("rescheduled");
    expect(smsKindFromSubject("Booking cancelled: Haircut on 2026-10-27")).toBe("cancelled");
    expect(smsKindFromSubject("Something else")).toBeNull();
  });

  it("engine still writes the subject prefixes the mapping relies on", () => {
    const src = readFileSync("src/lib/booking/engine.ts", "utf8");
    for (const p of ["`Booking confirmed:", "`Booking rescheduled:", "`Booking cancelled:"]) expect(src).toContain(p);
  });

  it("never sends unapproved text: unknown subjects give no body", () => {
    expect(smsBodyFor("Your weekly digest", { date: "2026-10-27", time: "10:00" }, biz)).toBeNull();
  });

  it("no reference id or free text leaks into the SMS", () => {
    const t = smsBodyFor("Booking confirmed: Haircut on 2026-10-27 at 10:00", { date: "2026-10-27", time: "10:00" }, "Ace Barbers")!;
    expect(t).toBe("FlowOps: Your appointment with Ace Barbers is confirmed for Tue Oct 27 at 10:00 AM. Reply STOP to opt out, HELP for help.");
    expect(t).not.toMatch(/Ref |Haircut/);
  });

  it("falls back cleanly when the business name is missing", () => {
    expect(smsText("confirmed", { date: "2026-10-27", time: "10:00" }, "  ")).toBe(
      "FlowOps: Your appointment is confirmed for Tue Oct 27 at 10:00 AM. Reply STOP to opt out, HELP for help.",
    );
  });
});
