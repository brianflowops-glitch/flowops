import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { COMPANY_ADDRESS, COMPANY_NAME, CONTACT_EMAIL, H2, LegalPage, UL } from "@/components/marketing/site-chrome";
import { SmsOptInFields } from "@/components/sms-consent-checkbox";

export const metadata: Metadata = {
  title: { absolute: "Text Message (SMS) Consent · FlowOps" },
  description: "How customers opt in to FlowOps texts: the booking-form checkbox is the only opt-in, and it is unchecked until the customer ticks it.",
  alternates: { canonical: "https://flowopsagent.ai/sms-consent" },
};

const SMS_NUMBER = "+1 (610) 426-1559";

/** Illustrative confirmation. {Business} stands in for the business name on the booking. */
const SAMPLE_CONFIRMATION =
  "FlowOps: Your appointment with {Business} is confirmed for Tue Oct 27 at 10:00 AM. Reply STOP to opt out, HELP for help.";

export default function SmsConsentPage() {
  return (
    <LegalPage title="Text Message (SMS) Consent" updated="October 26, 2026">
      <p>
        This page shows how people opt in to the <strong className="text-white">FlowOps texts</strong> program, operated by {COMPANY_NAME} (flowopsagent.ai) from
        our FlowOps phone number <strong className="text-white">{SMS_NUMBER}</strong>. FlowOps is a scheduling platform for small service businesses. We send
        appointment confirmations, reschedules and cancellations when a booking is saved.{" "}
        <strong className="text-white">We do not send marketing or promotional text messages.</strong>
      </p>

      <H2>Messages we send</H2>
      <UL>
        <li>Confirmations</li>
        <li>Reschedules</li>
        <li>Cancellations</li>
      </UL>
      <p>Each text goes out when that booking is saved, rescheduled, or cancelled. Nothing is scheduled for a time before the appointment.</p>

      <H2>The booking-form checkbox is the only way to opt in</H2>
      <p>
        When a customer books on a FlowOps booking page (for example{" "}
        <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai/book/flowops-demo">https://flowopsagent.ai/book/flowops-demo</a>), the
        &ldquo;Your details&rdquo; step asks for name, email and an optional phone number, followed by the checkbox below. The checkbox is{" "}
        <strong className="text-white">unchecked by default</strong> and is <strong className="text-white">optional</strong>: it is not required to book, and
        consent is not a condition of purchase. Appointment texts are sent only if the customer enters a mobile number and ticks the box.
      </p>
      <figure className="space-y-4">
        <figcaption className="font-mono text-[11px] uppercase tracking-wider text-slate-500">
          Phone field and consent checkbox on the booking form (unchecked, as it appears by default)
        </figcaption>
        <Image
          src="/sms-optin-checkbox.png"
          alt="Booking form phone field and the unchecked SMS consent checkbox, with the full consent wording"
          width={1440}
          height={374}
          className="h-auto w-full rounded-xl border border-white/10"
        />
        <div data-sms-optin-shot className="rounded-2xl border border-white/[0.08] bg-[#080e1c] p-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">4 · Your details</p>
          <SmsOptInFields />
        </div>
      </figure>
      <p>We record the opt-in choice and the time it was made with the booking. A confirmation text looks like this:</p>
      <p className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm leading-relaxed text-slate-200">{SAMPLE_CONFIRMATION}</p>

      <H2>Program terms</H2>
      <UL>
        <li>
          <strong className="text-white">Message frequency varies</strong> depending on your bookings.
        </li>
        <li>
          <strong className="text-white">Msg &amp; data rates may apply.</strong>
        </li>
        <li>
          <strong className="text-white">STOP:</strong> reply STOP to any message to opt out. You will get one confirmation and no further messages. Reply START to
          resubscribe.
        </li>
        <li>
          <strong className="text-white">HELP:</strong> reply HELP for help, or email{" "}
          <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          .
        </li>
        <li>
          <strong className="text-white">Carriers are not liable for delayed or undelivered messages.</strong>
        </li>
        <li>Mobile numbers and text-messaging opt-in data are never sold or shared with third parties for their marketing purposes.</li>
      </UL>
      <p>
        Full details: <Link href="/terms" className="text-cyan-300 hover:underline">Terms of Service</Link> (section 7, SMS / Text Messaging Terms) at{" "}
        <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai/terms">
          https://flowopsagent.ai/terms
        </a>{" "}
        and <Link href="/privacy" className="text-cyan-300 hover:underline">Privacy Policy</Link> at{" "}
        <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai/privacy">
          https://flowopsagent.ai/privacy
        </a>
        .
      </p>
      <p>
        Support: {COMPANY_NAME}, {COMPANY_ADDRESS} ·{" "}
        <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
      </p>
    </LegalPage>
  );
}
