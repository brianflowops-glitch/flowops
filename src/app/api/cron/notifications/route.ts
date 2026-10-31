import { timingSafeEqual } from "node:crypto";
import { sweepQueuedNotifications } from "@/lib/server/notification-sweeper";
import { runEmailReminders } from "@/lib/server/reminders/run";

/**
 * Recovery cron for notification rows stuck in "queued". Vercel Cron calls this with
 * `Authorization: Bearer ${CRON_SECRET}`. Fails closed: 503 when CRON_SECRET is unset, 401 on mismatch.
 * Schedule: vercel.json → daily at 14:00 UTC (`0 14 * * *`), which the Hobby plan allows.
 * Email reminders run after the sweeper and are a no-op unless EMAIL_REMINDERS_ENABLED is "true".
 */
export const maxDuration = 60;

function authorized(req: Request, secret: string) {
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return new Response("Not configured", { status: 503 });
  if (!authorized(req, secret)) return new Response("Unauthorized", { status: 401 });
  try {
    const report = await sweepQueuedNotifications();
    if (report.claimed || report.expired) console.log(`[sweeper] ${JSON.stringify(report)}`);
    // Email-only appointment reminders: a no-op (and not even in the response) unless EMAIL_REMINDERS_ENABLED=true.
    if (process.env.EMAIL_REMINDERS_ENABLED?.trim().toLowerCase() === "true") {
      const reminders = await runEmailReminders().catch((e: unknown) => {
        console.error(`[reminders] run failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
        return { error: "reminders failed" };
      });
      if ("sent" in reminders && (reminders.enqueued || reminders.claimed || reminders.expired)) console.log(`[reminders] ${JSON.stringify(reminders)}`);
      return Response.json({ ...report, reminders });
    }
    return Response.json(report);
  } catch (e) {
    console.error(`[sweeper] run failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`);
    return Response.json({ error: "sweep failed" }, { status: 500 });
  }
}
