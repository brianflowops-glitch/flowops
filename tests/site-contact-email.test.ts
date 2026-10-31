import { describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { CONTACT_EMAIL, PILOT_MAILTO } from "@/components/marketing/site-chrome";
import { BILLING_SUPPORT_EMAIL } from "@/lib/billing/support";
import HomePage from "@/app/(marketing)/home/page";
import PrivacyPage from "@/app/(marketing)/privacy/page";
import TermsPage from "@/app/(marketing)/terms/page";
import SmsConsentPage from "@/app/(marketing)/sms-consent/page";

const SUPPORT = "support@flowopsagent.ai";
const render = (C: ComponentType) => renderToStaticMarkup(createElement(C));
const PERSONAL = /[a-z0-9._%+-]+@(gmail|googlemail|yahoo|hotmail|outlook|icloud|proton(mail)?|aol|live)\.[a-z.]+/i;

describe("site-wide contact email", () => {
  it("CONTACT_EMAIL is support@flowopsagent.ai and drives the pilot mailto", () => {
    expect(CONTACT_EMAIL).toBe(SUPPORT);
    expect(PILOT_MAILTO.startsWith(`mailto:${SUPPORT}?`)).toBe(true);
  });

  it("billing support address is separate and unchanged", () => {
    expect(BILLING_SUPPORT_EMAIL).toBe("billing@flowopsagent.ai");
  });

  it.each([
    ["home", HomePage],
    ["privacy", PrivacyPage],
    ["terms", TermsPage],
    ["sms-consent", SmsConsentPage],
  ] as const)("/%s shows support@flowopsagent.ai (footer + body) and no personal address", (_name, Page) => {
    const html = render(Page);
    expect(html).toContain(`href="mailto:${SUPPORT}"`);
    expect(html).not.toMatch(PERSONAL);
  });

  it("/home 'Questions?' line uses CONTACT_EMAIL, not a hard-coded address", () => {
    const html = render(HomePage);
    expect(html).toContain(`Questions? Email <a href="mailto:${SUPPORT}"`);
    const src = readFileSync("src/app/(marketing)/home/page.tsx", "utf8");
    expect(src).not.toMatch(/mailto:[a-z0-9._%+-]+@/i);
  });

  it("/sms-consent is byte-identical to its 0c8ea7b render with only the address and toll-free number swapped", () => {
    // Fixture = renderToStaticMarkup of 0c8ea7b's /sms-consent with the old contact address
    // replaced by support@flowopsagent.ai and the 610 number replaced by the toll-free
    // +1 (833) 589-8939, and nothing else. A2P / toll-free reviewers read this page:
    // any other change to wording, punctuation or structure must fail here.
    const expected = readFileSync("tests/fixtures/sms-consent-0c8ea7b.html", "utf8");
    const html = render(SmsConsentPage);
    expect(html).toBe(expected);
    expect(html.split(SUPPORT).length - 1).toBe(5);
    expect(html).toContain("+1 (833) 589-8939");
    expect(html).not.toContain("426-1559");
  });
});
