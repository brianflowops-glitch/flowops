import "server-only";
import Stripe from "stripe";
import { AddonChangeBusy, addonLockFailureResponse } from "./addon-charges-db";


export const demoOrgResponse = () => Response.json({ error: "The demo organization can't change billing.", code: "demo_org" }, { status: 403 });

/** Lock / Stripe failures of a plan change or cancel → HTTP (null: rethrow). */
export function planChangeFailureResponse(err: unknown, what: string): Response | null {
  if (err instanceof AddonChangeBusy)
    return Response.json({ error: `Another billing change for this business is still being processed. Nothing was charged by this request; try again in a moment.`, code: "change_in_progress" }, { status: 409, headers: { "Retry-After": "5" } });
  const lock = addonLockFailureResponse(err);
  if (lock) return lock;
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    console.error(`[billing] ${what} rejected by Stripe`, err.code, err.message);
    return Response.json({ error: `Stripe rejected the ${what}`, code: "stripe_error" }, { status: 400 });
  }
  return null;
}
