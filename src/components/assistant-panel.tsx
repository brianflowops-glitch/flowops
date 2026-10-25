"use client";

import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { AlertTriangle, CalendarCheck, Send, Sparkles, X } from "lucide-react";
import { useBookings } from "@/lib/booking/store";
import { clsx } from "./clsx";

type Status = { configured: boolean; model?: string } | null;

const SUGGESTIONS = ["What's booked tomorrow?", "Is Room A free tomorrow afternoon?", "Book a consultation for Jane Doe (jane@example.com) tomorrow at 10:00"];
const TOOL_LABEL: Record<string, string> = {
  listServices: "Listing services",
  listBookings: "Looking up bookings",
  checkAvailability: "Checking availability",
  createBooking: "Creating booking",
  rescheduleBooking: "Rescheduling booking",
  cancelBooking: "Cancel booking",
};

type ToolOut = { ok?: boolean; outcome?: string; error?: string; booking?: { id: string; date: string; time: string; service: string } | null };

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refresh } = useBookings();
  const [status, setStatus] = useState<Status>(null);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, status: chatStatus, error, addToolApprovalResponse } = useChat({
    transport: new DefaultChatTransport({ api: "/api/assistant" }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => void refresh(),
  });
  const busy = chatStatus === "submitted" || chatStatus === "streaming";

  useEffect(() => {
    if (!open || status) return;
    fetch("/api/assistant")
      .then((r) => r.json())
      .then((s) => setStatus(s))
      .catch(() => setStatus({ configured: false }));
  }, [open, status]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  function send(text: string) {
    const content = text.trim();
    if (!content || busy || !status?.configured) return;
    setInput("");
    void sendMessage({ text: content });
  }

  return (
    <>
      <div className={clsx("fixed inset-0 z-40 bg-black/40 transition-opacity lg:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")} onClick={onClose} />
      <aside
        aria-hidden={!open}
        className={clsx(
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-white/[0.08] bg-[#080e1c]/95 shadow-2xl backdrop-blur-xl transition-[transform,visibility] duration-300",
          open ? "visible translate-x-0" : "invisible translate-x-full",
        )}
      >
        <header className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">FlowAI Assistant</p>
            <p className="font-mono text-[10.5px] text-slate-500">
              {status === null ? "checking backend…" : status.configured ? `connected · ${status.model} · booking tools on` : "backend not connected"}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto rounded-md p-1.5 text-slate-400 hover:bg-white/5" aria-label="Close assistant">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {status && !status.configured && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.07] p-4 text-sm text-amber-100">
              <div className="mb-2 flex items-center gap-2 font-medium text-amber-300">
                <AlertTriangle className="h-4 w-4" /> AI backend isn&apos;t connected yet
              </div>
              <p className="text-amber-100/80">
                FlowAI runs on Vercel AI Gateway. It connects automatically when deployed on Vercel; locally, run{" "}
                <code className="rounded bg-black/30 px-1 font-mono text-xs">vercel env pull</code> or set{" "}
                <code className="rounded bg-black/30 px-1 font-mono text-xs">AI_GATEWAY_API_KEY</code>.
              </p>
            </div>
          )}
          {status?.configured && messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-slate-400">
                Ask FlowAI to check availability, list, create, reschedule or cancel bookings. Every change runs the same pipeline as the Booking Center and is audit-logged under your name.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-full border border-white/10 px-3 py-1 text-left text-xs text-slate-300 hover:border-cyan-400/40 hover:text-white">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={clsx("space-y-2", m.role === "user" && "flex flex-col items-end")}>
              {m.parts.map((part, i) => {
                if (part.type === "text") {
                  if (!part.text.trim()) return null;
                  return (
                    <div key={i} className={clsx("max-w-[90%] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm", m.role === "user" ? "bg-cyan-500/15 text-cyan-50" : "bg-white/[0.04] text-slate-200")}>
                      {part.text}
                    </div>
                  );
                }
                if (!isToolUIPart(part)) return null;
                const name = getToolName(part);
                const label = TOOL_LABEL[name] ?? name;
                const input = (part.input ?? {}) as Record<string, string>;
                if (part.state === "approval-requested") {
                  return (
                    <div key={i} className="max-w-[90%] rounded-xl border border-rose-400/30 bg-rose-400/[0.06] p-3 text-sm text-rose-100">
                      <p className="font-medium">Confirm: cancel booking {input.bookingId}?</p>
                      <p className="mt-0.5 text-xs text-rose-100/70">The customer will be notified and the calendar event removed.</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: true })}
                          className="rounded-md bg-rose-500/80 px-3 py-1 text-xs font-medium text-white hover:bg-rose-500"
                        >
                          Yes, cancel it
                        </button>
                        <button
                          onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: false, reason: "User declined the cancellation" })}
                          className="rounded-md border border-white/15 px-3 py-1 text-xs text-slate-200 hover:bg-white/5"
                        >
                          Keep booking
                        </button>
                      </div>
                    </div>
                  );
                }
                const out = (part.state === "output-available" ? part.output : null) as ToolOut | null;
                const text =
                  part.state === "output-denied"
                    ? `${label}: declined — nothing changed`
                    : part.state === "output-error"
                      ? `${label}: error — ${part.errorText}`
                      : part.state === "output-available"
                        ? out?.booking && out.ok !== false
                          ? `${label} ✓ ${out.booking.id} · ${out.booking.service} · ${out.booking.date} ${out.booking.time}`
                          : out?.ok === false
                            ? `${label}: ${out.outcome ?? "failed"} — ${out.error ?? ""}`
                            : `${label} ✓`
                        : `${label}…`;
                return (
                  <div key={i} className="flex max-w-[90%] items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-1.5 font-mono text-[11px] text-slate-400">
                    <CalendarCheck className="h-3.5 w-3.5 shrink-0 text-cyan-300" /> {text}
                  </div>
                );
              })}
            </div>
          ))}
          {chatStatus === "submitted" && <div className="w-16 animate-pulse rounded-xl bg-white/[0.04] px-3.5 py-2.5 text-sm text-slate-400">…</div>}
          {error && <div className="rounded-lg border border-rose-400/30 bg-rose-400/[0.06] p-3 text-xs text-rose-200">FlowAI request failed: {error.message}</div>}
        </div>

        <form
          className="border-t border-white/[0.06] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 focus-within:border-cyan-400/40">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!status?.configured || busy}
              placeholder={status?.configured ? "Ask FlowAI to book, move or cancel…" : "Assistant offline — AI Gateway not connected"}
              className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-600 focus:outline-none disabled:cursor-not-allowed"
            />
            <button type="submit" disabled={!status?.configured || busy || !input.trim()} className="rounded-lg bg-cyan-500 p-1.5 text-white disabled:opacity-30" aria-label="Send">
              <Send className="h-4 w-4" />
            </button>
          </div>
        </form>
      </aside>
    </>
  );
}
