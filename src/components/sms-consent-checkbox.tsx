import { SMS_CONSENT_TEXT } from "@/lib/phone";

/** Same field chrome as the public booking form. */
export const bookingFieldClass =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10";

/** Optional phone input from the booking form's "Your details" step. */
export function BookingPhoneField({ name = "phone" }: { name?: string }) {
  return <input name={name} type="tel" placeholder="Phone (optional)" autoComplete="tel" className={bookingFieldClass} />;
}

/**
 * The booking-form SMS opt-in. Unchecked unless the customer ticks it.
 * `name` is set on the real form so the submit handler can read it.
 */
export function SmsConsentCheckbox({ name }: { name?: string }) {
  return (
    <label className="flex items-start gap-2 text-xs leading-relaxed text-slate-400">
      <input name={name} type="checkbox" defaultChecked={false} className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-400" />
      <span>
        {SMS_CONSENT_TEXT} See our{" "}
        <a href="/terms" target="_blank" rel="noopener" className="text-cyan-300 hover:underline">
          Terms
        </a>{" "}
        and{" "}
        <a href="/privacy" target="_blank" rel="noopener" className="text-cyan-300 hover:underline">
          Privacy Policy
        </a>
        .
      </span>
    </label>
  );
}

/** Phone field plus the unchecked consent checkbox, exactly as the booking form renders them. */
export function SmsOptInFields({ nameFields = false }: { nameFields?: boolean }) {
  return (
    <div className="space-y-3">
      <BookingPhoneField name={nameFields ? "phone" : undefined} />
      <SmsConsentCheckbox name={nameFields ? "smsConsent" : undefined} />
    </div>
  );
}
