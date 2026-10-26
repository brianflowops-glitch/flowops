import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY_ADDRESS, COMPANY_NAME, CONTACT_EMAIL, H2, LegalPage, UL } from "@/components/marketing/site-chrome";
import { SMS_CONSENT_TEXT } from "@/lib/phone";

export const metadata: Metadata = {
  title: { absolute: "Text Message (SMS) Consent · FlowOps" },
  description: "How customers opt in to FlowOps texts: the exact booking-form checkbox and wording, and replies to people who text us first.",
  alternates: { canonical: "https://flowopsagent.ai/sms-consent" },
};

const SMS_NUMBER = "+1 (610) 426-1559";

export default function SmsConsentPage() {
  return (
    <LegalPage title="Text Message (SMS) Consent" updated="October 26, 2026">
      <p>
        This page shows how people opt in to the <strong className="text-white">FlowOps texts</strong> program, operated by {COMPANY_NAME} (flowopsagent.ai) from
        our FlowOps phone number <strong className="text-white">{SMS_NUMBER}</strong>. FlowOps is a scheduling platform for small service businesses. We send
        appointment messages and answer questions from customers who text us first.{" "}
        <strong className="text-white">We do not send marketing or promotional text messages.</strong>
      </p>

      <H2>Messages we send</H2>
      <UL>
        <li>Appointment confirmations</li>
        <li>Reschedule notices</li>
        <li>Cancellation notices</li>
        <li>Appointment reminders</li>
        <li>Answers to questions from customers who text our number first</li>
      </UL>

      <H2>Opt-in path 1: checkbox on the booking form</H2>
      <p>
        When a customer books on a FlowOps booking page (for example{" "}
        <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai/book/flowops-demo">https://flowopsagent.ai/book/flowops-demo</a>), the
        &ldquo;Your details&rdquo; step asks for name, email and an optional phone number, followed by the checkbox below. The checkbox is{" "}
        <strong className="text-white">unchecked by default</strong> and is <strong className="text-white">optional</strong>: it is not required to book, and
        consent is not a condition of purchase. Appointment texts are sent only if the customer enters a mobile number and ticks the box.
      </p>
      <figure className="rounded-xl border border-white/10 bg-black/30 p-5">
        <figcaption className="mb-3 font-mono text-[11px] uppercase tracking-wider text-slate-500">
          Exact checkbox and wording shown on the booking form (shown unchecked, as it appears by default)
        </figcaption>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">4 · Your details</p>
        <div className="space-y-2 text-sm text-slate-500">
          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">Full name</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">Email</div>
            <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">Phone (optional)</div>
          </div>
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-slate-300">
          <input type="checkbox" disabled aria-label="Example SMS opt-in checkbox (unchecked)" className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-400" />
          <span id="sms-consent-checkbox-text">
            {SMS_CONSENT_TEXT} See our{" "}
            <a href="https://flowopsagent.ai/terms" className="text-cyan-300 hover:underline">Terms</a> and{" "}
            <a href="https://flowopsagent.ai/privacy" className="text-cyan-300 hover:underline">Privacy Policy</a>.
          </span>
        </label>
      </figure>
      <p>
        We record the opt-in choice and the time it was made with the booking. The first text a customer receives identifies FlowOps and includes
        &ldquo;Reply STOP to opt out.&rdquo;
      </p>

      <H2>Opt-in path 2: customers who text us first</H2>
      <p>
        A customer can text our number <strong className="text-white">{SMS_NUMBER}</strong> with a question (for example about their appointment or our service).
        By texting us first, the customer agrees to receive replies in that conversation. We reply only to their question; we do not add them to any marketing
        list. Our first reply includes &ldquo;Reply HELP for help, STOP to opt out.&rdquo;
      </p>

      <H2>Program terms</H2>
      <UL>
        <li><strong className="text-white">Message frequency varies</strong> depending on your bookings and conversations with us.</li>
        <li><strong className="text-white">Msg &amp; data rates may apply.</strong></li>
        <li>
          <strong className="text-white">STOP:</strong> reply STOP to any message to opt out. You will get one confirmation and no further messages. Reply START to
          resubscribe.
        </li>
        <li>
          <strong className="text-white">HELP:</strong> reply HELP for help, or email{" "}
          <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </li>
        <li><strong className="text-white">Carriers are not liable for delayed or undelivered messages.</strong></li>
        <li>
          Mobile numbers and text-messaging opt-in data are never sold or shared with third parties for their marketing purposes.
        </li>
      </UL>
      <p>
        Full details: <Link href="/terms" className="text-cyan-300 hover:underline">Terms of Service</Link> (section 7, SMS / Text Messaging Terms) at{" "}
        <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai/terms">https://flowopsagent.ai/terms</a> and{" "}
        <Link href="/privacy" className="text-cyan-300 hover:underline">Privacy Policy</Link> at{" "}
        <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai/privacy">https://flowopsagent.ai/privacy</a>.
      </p>
      <p>
        Support: {COMPANY_NAME}, {COMPANY_ADDRESS} ·{" "}
        <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </LegalPage>
  );
}
