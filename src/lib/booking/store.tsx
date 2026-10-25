"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BookingEngine, emptyState } from "./engine";
import type { BookingRequest, EngineState, RunOptions } from "./types";

const STORAGE_KEY = "flowops.booking-engine.v1";

interface BookingStore {
  state: EngineState;
  hydrated: boolean;
  create: (req: BookingRequest, opts?: RunOptions) => ReturnType<BookingEngine["create"]>;
  reschedule: (id: string, date: string, time: string, opts?: RunOptions) => ReturnType<BookingEngine["reschedule"]>;
  cancel: (id: string, opts?: RunOptions) => ReturnType<BookingEngine["cancel"]>;
  reset: () => void;
}

const Ctx = createContext<BookingStore | null>(null);

export function BookingProvider({ children }: { children: React.ReactNode }) {
  const engineRef = useRef<BookingEngine | null>(null);
  if (engineRef.current == null) {
    engineRef.current = new BookingEngine();
  }
  const [state, setState] = useState<EngineState>(emptyState);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        engineRef.current = new BookingEngine(JSON.parse(raw) as EngineState);
        setState(engineRef.current.snapshot());
      }
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, []);

  const sync = useCallback(() => {
    const snap = engineRef.current!.snapshot();
    setState(snap);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    } catch {
      /* storage full / disabled */
    }
  }, []);

  const value = useMemo<BookingStore>(
    () => ({
      state,
      hydrated,
      create: async (req, opts) => {
        const r = await engineRef.current!.create(req, opts);
        sync();
        return r;
      },
      reschedule: async (id, date, time, opts) => {
        const r = await engineRef.current!.reschedule(id, date, time, opts);
        sync();
        return r;
      },
      cancel: async (id, opts) => {
        const r = await engineRef.current!.cancel(id, opts);
        sync();
        return r;
      },
      reset: () => {
        engineRef.current!.reset();
        sync();
      },
    }),
    [state, hydrated, sync],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBookings() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBookings must be used inside <BookingProvider>");
  return v;
}
