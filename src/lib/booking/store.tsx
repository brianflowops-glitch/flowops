"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { emptyState } from "./engine";
import type { AgentStep, BookingRequest, EngineState, PipelineAgent, PipelineResult, WeekHoursClient } from "./types";
import { isBillingLockedResponse } from "@/lib/billing/lock-copy";

export interface ServiceRow {
  id: string;
  name: string;
  category: BookingRequest["category"];
  durationMin: number;
  resource: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
}

export interface Me {
  user: { id: string; name: string; email: string; emailVerified: boolean };
  role: "owner" | "admin" | "staff";
  org: {
    id: string;
    slug: string;
    name: string;
    timeZone: string;
    hours: WeekHoursClient;
    publicBooking: boolean;
    isDemo: boolean;
    googleConnected: boolean;
    googleAccountEmail: string | null;
    createdAt?: string;
  };
  team?: { members: number; invites: number };
  today: { date: string; time: string };
  services: ServiceRow[];
  integrations: {
    smsMode: "live" | "trial" | "needs_number" | "not_set" | "error";
    smsFrom: string | null;
    googleCalendar: boolean; resendEmail: boolean; resendFrom: boolean; twilioSms: boolean; emailVerificationRequired: boolean };
}

export interface ClientRunOptions {
  /** Delay per step when replaying the server's pipeline steps (UI animation). */
  stepDelayMs?: number;
  onStep?: (steps: AgentStep[]) => void;
  failAgent?: PipelineAgent;
}

interface BookingStore {
  state: EngineState & { sources?: Record<string, "dashboard" | "assistant" | "public"> };
  me: Me | null;
  hydrated: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (req: BookingRequest, opts?: ClientRunOptions) => Promise<PipelineResult>;
  reschedule: (id: string, date: string, time: string, opts?: ClientRunOptions) => Promise<PipelineResult>;
  cancel: (id: string, opts?: ClientRunOptions) => Promise<PipelineResult>;
}

const Ctx = createContext<BookingStore | null>(null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function replay(final: AgentStep[], opts?: ClientRunOptions) {
  if (!opts?.onStep) return;
  const delay = opts.stepDelayMs ?? 0;
  for (let i = 0; i < final.length && delay > 0; i++) {
    opts.onStep(
      final.map((s, j) =>
        j < i ? s : j === i ? { ...s, status: "running", message: "Running…" } : { ...s, status: "pending", message: "Waiting" },
      ),
    );
    await sleep(delay);
  }
  opts.onStep(final);
}

/** Bookings, audit log and notifications live in Postgres; this provider reads/writes them via the API. */
export function BookingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<BookingStore["state"]>(emptyState);
  const [me, setMe] = useState<Me | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (res.status === 401) {
        router.push("/sign-in");
        return;
      }
      const data = await res.json();
      // Billing got locked mid-session: re-render the layout, which shows the billing lock screen.
      if (isBillingLockedResponse(res.status, data)) {
        router.refresh();
        return;
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setState(data.state);
      setMe({ user: data.user, role: data.role, org: data.org, today: data.today, services: data.services, team: data.team, integrations: data.integrations });
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setHydrated(true);
    }
  }, [router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load from the API
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (body: Record<string, unknown>, opts?: ClientRunOptions): Promise<PipelineResult> => {
      opts?.onStep?.(
        (["IntentAgent", "BookingAgent", "AvailabilityAgent", "CalendarAgent", "NotificationAgent", "AuditAgent"] as PipelineAgent[]).map((agent, i) => ({
          agent,
          status: i === 0 ? "running" : "pending",
          message: i === 0 ? "Running on FLOWOPS Core…" : "Waiting",
          simulated: false,
          durationMs: 0,
        })),
      );
      let result: PipelineResult;
      try {
        const res = await fetch("/api/bookings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...(opts?.failAgent ? { failAgent: opts.failAgent } : {}) }),
        });
        const data = await res.json();
        if (!res.ok || !Array.isArray(data.steps)) throw new Error(data.error ?? `HTTP ${res.status}`);
        result = data;
      } catch (e) {
        result = {
          action: body.action as PipelineResult["action"],
          ok: false,
          verified: false,
          outcome: "invalid",
          booking: null,
          steps: [],
          error: String(e instanceof Error ? e.message : e),
        };
      }
      await replay(result.steps, opts);
      await refresh();
      return result;
    },
    [refresh],
  );

  const value = useMemo<BookingStore>(
    () => ({
      state,
      me,
      hydrated,
      error,
      refresh,
      create: (req, opts) => run({ action: "create", req }, opts),
      reschedule: (bookingId, date, time, opts) => run({ action: "reschedule", bookingId, date, time }, opts),
      cancel: (bookingId, opts) => run({ action: "cancel", bookingId }, opts),
    }),
    [state, me, hydrated, error, refresh, run],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBookings() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBookings must be used inside <BookingProvider>");
  return v;
}
