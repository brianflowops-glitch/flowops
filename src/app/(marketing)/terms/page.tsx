import type { Metadata } from "next";
import Link from "next/link";
import { COMPANY_ADDRESS, COMPANY_NAME, CONTACT_EMAIL, H2, LegalPage, UL } from "@/components/marketing/site-chrome";

export const metadata: Metadata = {
  title: { absolute: "Terms of Service · FlowOps" },
  description: "The terms for using FlowOps, including our SMS / text messaging terms.",
  alternates: { canonical: "https://flowopsagent.ai/terms" },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="October 26, 2026">
      <p>
        These Terms of Service (&quot;Terms&quot;) are an agreement between you and {COMPANY_NAME} (&quot;FlowOps&quot;, &quot;we&quot;, &quot;us&quot;), and govern your
        use of FlowOps, the booking and operations service at flowopsagent.ai (the &quot;Service&quot;). By creating an account or using the
        Service you agree to them. If you use FlowOps on behalf of a business, you agree for that business and confirm you are authorized to do so.
      </p>

      <H2>1. The Service</H2>
      <p>
        FlowOps lets businesses publish a booking page, manage bookings, sync them with Google Calendar, send booking emails, invite team members with roles, and use
        FlowAI, an AI assistant that can look up, create, reschedule and cancel bookings on a user&apos;s request. Some parts of the dashboard show sample or
        simulated data and are labelled as such.
      </p>

      <H2>2. Pilot and beta status</H2>
      <p>
        FlowOps is in an early pilot. Features may change, be added or be removed, and the Service may have bugs or interruptions. During the founding pilot the
        Service is provided free of charge. We will give workspace owners notice before any paid plan applies to them; nothing is charged without your agreement.
      </p>

      <H2>3. Accounts</H2>
      <UL>
        <li>You must give accurate information, keep your password secure, and be at least 18 (or the age of majority where you live).</li>
        <li>You are responsible for activity under your account and for the team members you invite to your workspace and the roles you give them.</li>
        <li>Tell us promptly at {CONTACT_EMAIL} if you believe your account has been compromised.</li>
      </UL>

      <H2>4. Your data and your customers</H2>
      <p>
        You own the business information and booking data you and your customers put into your workspace (&quot;Your Data&quot;). You give us permission to host,
        process and transmit Your Data only as needed to provide and secure the Service, as described in our{" "}
        <Link href="/privacy" className="text-cyan-300 hover:underline">Privacy Policy</Link>. You are responsible for having the right to collect and use your end
        customers&apos; information, for any notices or consents your customers need (including for emails or text messages you send them through FlowOps), and for
        complying with laws that apply to your business.
      </p>

      <H2>5. Acceptable use</H2>
      <p>You agree not to:</p>
      <UL>
        <li>use the Service for anything unlawful, deceptive or harmful, or to send spam or unsolicited messages;</li>
        <li>upload malicious code, probe or overload the Service, get around rate limits or security, or access another workspace&apos;s data;</li>
        <li>create fake bookings, impersonate others, or collect information about people without a lawful basis;</li>
        <li>resell or copy the Service, or use it to build a competing product, without our written permission.</li>
      </UL>
      <p>We may suspend accounts or workspaces that break these rules or put the Service or other users at risk.</p>

      <H2>6. FlowAI</H2>
      <p>
        FlowAI uses third-party AI models and can make mistakes. Review what it proposes, especially dates, times and customer details. FlowAI only acts through
        FlowOps&apos;s booking tools, cancellations require your confirmation, and every change is logged — but you remain responsible for actions you ask it to take.
        Usage limits apply and FlowAI may be temporarily unavailable.
      </p>

      <H2>7. SMS / Text Messaging Terms</H2>
      <p>
        <strong className="text-white">Program name:</strong> FlowOps texts. The program is operated by {COMPANY_NAME} from our FlowOps phone number.
      </p>
      <p>
        <strong className="text-white">What messages we send:</strong>
      </p>
      <UL>
        <li>
          <strong className="text-white">Appointment messages</strong> — booking confirmations, reschedule notices, cancellation notices and appointment reminders,
          sent to people who give a mobile number and tick the text-message opt-in box when booking on a FlowOps booking page (for example{" "}
          <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai/book/flowops-demo">flowopsagent.ai/book/flowops-demo</a>), or who otherwise agree
          to receive appointment texts.
        </li>
        <li>
          <strong className="text-white">Replies to people who text us</strong> — when you text our number first with questions about FlowOps, its features, pricing
          or sales, we reply to your questions in that conversation.
        </li>
      </UL>
      <UL>
        <li><strong className="text-white">Consent is not a condition of purchase.</strong> You do not have to agree to receive texts to book an appointment or buy any product or service.</li>
        <li><strong className="text-white">Message frequency varies</strong> depending on your bookings and conversations with us.</li>
        <li><strong className="text-white">Msg &amp; data rates may apply.</strong> Check with your mobile carrier for details about your plan.</li>
        <li>
          <strong className="text-white">Opt out:</strong> reply <strong className="text-white">STOP</strong> to any message at any time to stop receiving texts.
          You will receive one final message confirming you have been unsubscribed, and no further messages will be sent. Reply{" "}
          <strong className="text-white">START</strong> to resubscribe.
        </li>
        <li>
          <strong className="text-white">Help:</strong> reply <strong className="text-white">HELP</strong> to any message for help, or email{" "}
          <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </li>
        <li>
          <strong className="text-white">Carriers are not liable for delayed or undelivered messages.</strong> Delivery of text messages is not guaranteed.
        </li>
        <li>
          <strong className="text-white">Privacy:</strong> how we handle your mobile number and messaging data is described in our{" "}
          <Link href="/privacy" className="text-cyan-300 hover:underline">Privacy Policy</Link>. We do not sell or share mobile numbers or text-messaging opt-in
          data with third parties for their marketing purposes.
        </li>
        <li>
          <strong className="text-white">Support:</strong> {COMPANY_NAME}, {COMPANY_ADDRESS} ·{" "}
          <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> ·{" "}
          <a className="text-cyan-300 hover:underline" href="https://flowopsagent.ai">flowopsagent.ai</a>
        </li>
      </UL>

      <H2>8. Third-party services</H2>
      <p>
        Some features depend on other providers, such as Google Calendar, Resend (email), Twilio (text messages), Vercel and Neon. Their availability and
        terms are outside our control, and your use of a connected service such as Google Calendar is also subject to that provider&apos;s terms.
      </p>

      <H2>9. Fees</H2>
      <p>
        The Service is free during the pilot. If we introduce paid plans, prices and billing terms will be shown before you choose a plan, and these terms will be
        updated.
      </p>

      <H2>10. Ending your use</H2>
      <p>
        You can stop using FlowOps at any time and ask us to delete your workspace by emailing {CONTACT_EMAIL}. We may end or suspend the Service, or your access, with
        reasonable notice where possible (or immediately for serious misuse). On request before deletion, we will help you export your bookings.
      </p>

      <H2>11. Disclaimers</H2>
      <p>
        The Service is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, including fitness for a particular purpose, accuracy or
        uninterrupted availability. You are responsible for keeping your own records of important appointments.
      </p>

      <H2>12. Limitation of liability</H2>
      <p>
        To the fullest extent the law allows, FlowOps will not be liable for indirect, incidental, special, consequential or punitive damages, or for lost profits,
        revenue, data or business, and our total liability for any claim relating to the Service is limited to the greater of the amount you paid us for the Service
        in the 12 months before the claim or US $100.
      </p>

      <H2>13. Changes to these terms</H2>
      <p>
        We may update these terms. We will change the &quot;Last updated&quot; date and, for material changes, notify workspace owners by email or in the app before
        they take effect. Continuing to use the Service after that means you accept the updated terms.
      </p>

      <H2>14. Governing law</H2>
      <p>These terms are governed by the laws of the Commonwealth of Pennsylvania, USA, without regard to conflict-of-law rules.</p>

      <H2>15. Contact</H2>
      <p>
        Questions about these terms: {COMPANY_NAME}, {COMPANY_ADDRESS} ·{" "}
        <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}
