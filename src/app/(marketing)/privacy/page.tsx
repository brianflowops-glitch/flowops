import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, H2, LegalPage, UL } from "@/components/marketing/site-chrome";

export const metadata: Metadata = {
  title: { absolute: "Privacy Policy (draft) · FlowOps" },
  description: "What data FlowOps collects, how it is used, which service providers process it, and your choices. Draft pending review.",
  alternates: { canonical: "https://flowopsagent.ai/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="October 25, 2026">
      <p>
        This policy explains what information FlowOps (&quot;FlowOps&quot;, &quot;we&quot;, &quot;us&quot;) collects when you use the FlowOps website and app at
        flowopsagent.ai (the &quot;Service&quot;), how we use it, and the choices you have. FlowOps is used by businesses (&quot;Customers&quot; or
        &quot;workspaces&quot;) to take bookings from their own clients (&quot;end customers&quot;).
      </p>

      <H2>1. Information we collect</H2>
      <p>
        <strong className="text-white">Account information.</strong> When you create an account: your name, email address, a password (stored only as a salted hash —
        we never see or store it in plain text), an optional business name, and whether your email has been verified. When you sign in we store a session record that
        includes your IP address and browser user-agent, used to keep you signed in and to protect accounts.
      </p>
      <p>
        <strong className="text-white">Workspace and business information.</strong> Your business name, booking-page address, time zone, opening hours, the services you
        offer (name, duration, the resource booked such as a room, person or vehicle), team members and their roles, and team invitations (the invited email and role;
        invite links are stored only as one-way hashes).
      </p>
      <p>
        <strong className="text-white">Bookings and end-customer contact information.</strong> For each booking: the end customer&apos;s name, email address, optional
        phone number, optional notes, the service, date and time, and its status. Bookings can be made by end customers on a public booking page, by workspace users
        in the dashboard, or by FlowAI on a user&apos;s request.
      </p>
      <p>
        <strong className="text-white">Activity and audit records.</strong> A log of booking actions (created, rescheduled, cancelled, conflicts, failures) with the
        acting user, and a record of notifications sent or attempted. We use these to run the Service, troubleshoot, and show workspace owners what happened.
      </p>
      <p>
        <strong className="text-white">Technical and security data.</strong> IP addresses and request counts used for rate limiting and abuse prevention, and
        standard server logs kept by our hosting provider. We do not use advertising trackers or sell analytics data.
      </p>

      <H2>2. Google Calendar data</H2>
      <p>
        If a workspace owner chooses to connect Google Calendar, FlowOps asks Google for the <code className="text-cyan-200">calendar.events</code> scope
        (<code className="text-cyan-200">https://www.googleapis.com/auth/calendar.events</code>) plus basic sign-in scopes (<code className="text-cyan-200">openid</code>{" "}
        and <code className="text-cyan-200">email</code>) so we know which Google account was connected.
      </p>
      <UL>
        <li>
          <strong className="text-white">What we do with it:</strong> create, update and delete calendar events for bookings made in FlowOps — for example, adding an
          event when a booking is confirmed, moving it when the booking is rescheduled, and removing it when the booking is cancelled. Events contain the booking&apos;s
          service, time, resource and the end customer&apos;s name, email, phone and notes.
        </li>
        <li>
          <strong className="text-white">What we don&apos;t do:</strong> FlowOps does not read, copy or analyze your other calendar events, does not use Google data
          for advertising, does not sell it, and does not use it to train AI models. Google user data is not sent to AI providers.
        </li>
        <li>
          <strong className="text-white">What we store:</strong> an encrypted OAuth refresh token, the connected Google account&apos;s email address, the calendar ID
          used, and the Google event ID for each synced booking.
        </li>
        <li>
          <strong className="text-white">Disconnecting:</strong> the owner can disconnect Google Calendar in Administration at any time, which deletes the stored token.
          You can also revoke FlowOps&apos;s access from your Google Account at{" "}
          <a className="text-cyan-300 hover:underline" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
        </li>
      </UL>
      <p>
        FlowOps&apos;s use and transfer of information received from Google APIs will adhere to the{" "}
        <a className="text-cyan-300 hover:underline" href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <H2>3. How we use information</H2>
      <UL>
        <li>To provide the Service: accounts, workspaces, booking pages, availability checks, calendar sync and notifications.</li>
        <li>To send service emails: email verification, password resets, team invitations, and booking confirmations, changes and cancellations.</li>
        <li>To run FlowAI when a workspace user asks it to (see section 4).</li>
        <li>To secure the Service: rate limiting, preventing abuse, and investigating problems.</li>
        <li>To communicate with workspace owners about the Service, including the pilot program.</li>
      </UL>
      <p>We do not sell personal information and do not share it for cross-context behavioral advertising.</p>

      <H2>4. FlowAI and AI processing</H2>
      <p>
        FlowAI is an optional assistant inside the dashboard. When a signed-in user sends FlowAI a message, the conversation, the workspace&apos;s name, hours and
        services, and any booking details FlowAI looks up to answer (which can include end-customer names, emails, phone numbers and notes) are sent through{" "}
        <strong className="text-white">Vercel AI Gateway</strong> to a third-party AI model provider (currently OpenAI) to generate the reply. FlowAI only acts
        through FlowOps&apos;s own booking tools, and cancellations require the user&apos;s confirmation. FlowOps does not store FlowAI chat transcripts beyond the
        user&apos;s browser session, although booking changes FlowAI makes are recorded in the audit log. AI providers process this data under their API terms,
        which (for OpenAI&apos;s API) do not use API data to train their models by default.
      </p>

      <H2>5. Service providers we use</H2>
      <p>We share information only with providers that help us run the Service, and only as needed for that purpose:</p>
      <UL>
        <li><strong className="text-white">Vercel</strong> — hosts the website and app, and provides AI Gateway for FlowAI requests.</li>
        <li><strong className="text-white">Neon</strong> — hosts our Postgres database, where accounts, workspaces and bookings are stored (United States).</li>
        <li><strong className="text-white">Resend</strong> — delivers our emails (verification, password reset, invites and booking notifications).</li>
        <li><strong className="text-white">Google</strong> — Google Calendar, only for workspaces that connect it.</li>
        <li><strong className="text-white">AI model providers</strong> (currently OpenAI, via Vercel AI Gateway) — generate FlowAI replies.</li>
        <li><strong className="text-white">Twilio</strong> — if and when text-message notifications are turned on, to deliver SMS to the phone number on a booking.</li>
        <li><strong className="text-white">Cloudflare</strong> — DNS for our domain.</li>
      </UL>
      <p>We may also disclose information if required by law, to protect the rights and safety of users or the public, or as part of a merger or sale of the business.</p>

      <H2>6. Workspaces and end customers</H2>
      <p>
        Each business&apos;s workspace is kept separate. Booking and end-customer information entered into a workspace belongs to that business, which decides how
        it is used to serve its own clients. If you booked an appointment with a business that uses FlowOps and want your information changed or removed, please
        contact that business; you can also contact us and we will pass the request on.
      </p>

      <H2>7. Retention and deletion</H2>
      <p>
        We keep account, workspace and booking data for as long as the account or workspace is active. A workspace owner can ask us to delete the workspace and its
        data, or an account, at any time by emailing us; we will delete it from the live database within 30 days, except where we must keep records for legal or
        security reasons. Rate-limit records are short-lived. Sessions expire automatically.
      </p>

      <H2>8. Security</H2>
      <p>
        Data is encrypted in transit (HTTPS). Passwords are hashed, invite and reset links are single-use and expire, Google refresh tokens are encrypted at rest,
        and access to each workspace is limited by role. No system is perfectly secure; please use a strong, unique password.
      </p>

      <H2>9. Your choices and rights</H2>
      <p>
        You can update your business details in the app, disconnect Google Calendar at any time, and ask us for a copy of, correction to, or deletion of your
        personal information by emailing <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Depending on where you
        live, you may have additional rights under local law; we will honor them as required.
      </p>

      <H2>10. Children</H2>
      <p>FlowOps is a business tool and is not directed to children under 16. We do not knowingly collect personal information from children.</p>

      <H2>11. Changes</H2>
      <p>We may update this policy. We will change the &quot;Last updated&quot; date and, for material changes, notify workspace owners by email or in the app.</p>

      <H2>12. Contact</H2>
      <p>
        Questions or requests: <a className="text-cyan-300 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. See also our{" "}
        <Link href="/terms" className="text-cyan-300 hover:underline">Terms of Service</Link>.
      </p>
    </LegalPage>
  );
}
