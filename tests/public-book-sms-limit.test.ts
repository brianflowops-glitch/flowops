import { beforeAll, describe, expect, it } from "vitest";
import { initTestDb } from "./helpers/db";
import { BASE, futureWeekday, params, seedDemoOrg } from "./helpers/app";
import { getDb, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { DEMO_ORG_ID, DEMO_ORG_SLUG } from "@/lib/tenancy/defaults";
import * as book from "@/app/api/public/[slug]/book/route";

let serviceId: string;

function bookReq(i: number, body: Record<string, unknown>) {
  return new Request(`${BASE}/api/public/${DEMO_ORG_SLUG}/book`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-real-ip": `203.0.113.${i}`, "x-forwarded-for": `203.0.113.${i}` },
    body: JSON.stringify({ serviceId, date: futureWeekday(14 + i * 7), time: "10:00", name: `Cust ${i}`, email: `c${i}@cust.test`, ...body }),
  });
}

describe("public booking: SMS opt-ins per phone number", () => {
  beforeAll(async () => {
    await initTestDb();
    await seedDemoOrg();
    const [svc] = await getDb().select().from(schema.service).where(eq(schema.service.organizationId, DEMO_ORG_ID)).limit(1);
    serviceId = svc.id;
  });

  it("allows 5 text opt-ins for one number per day (any formatting), then refuses the 6th with texts on", async () => {
    const formats = ["610-555-0199", "(610) 555-0199", "+16105550199", "1 610 555 0199", "6105550199"];
    for (const [i, phone] of formats.entries()) {
      const res = await book.POST(bookReq(i, { phone, smsConsent: true }), params({ slug: DEMO_ORG_SLUG }));
      expect(res.status, `booking ${i}: ${await res.clone().text()}`).toBeLessThan(300);
    }
    const rows = await getDb().select().from(schema.booking).where(eq(schema.booking.organizationId, DEMO_ORG_ID));
    expect(rows.filter((b) => b.smsConsent && b.phone === "+16105550199")).toHaveLength(5);
    const sixth = await book.POST(bookReq(5, { phone: "610.555.0199", smsConsent: true }), params({ slug: DEMO_ORG_SLUG }));
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error).toMatch(/text-message sign-ups/);
  });

  it("still lets the customer book with the same number when texts are off", async () => {
    const res = await book.POST(bookReq(6, { phone: "610-555-0199", smsConsent: false }), params({ slug: DEMO_ORG_SLUG }));
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });

  it("a different number is unaffected", async () => {
    const res = await book.POST(bookReq(7, { phone: "610-555-0142", smsConsent: true }), params({ slug: DEMO_ORG_SLUG }));
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });
});
