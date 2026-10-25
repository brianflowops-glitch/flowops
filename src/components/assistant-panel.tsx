"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Send, Sparkles, X } from "lucide-react";
import { useBookings } from "@/lib/booking/store";
import { clsx } from "./clsx";

type Msg = { role: "user" | "assistant"; content: string };
type Status = { configured: boolean; model?: string } | null;

const SUGGESTIONS = ["Summarize today's bookings", "Explain the booking pipeline", "What's on the roadmap?"];

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useBookings();
  const [status, setStatus] = useState<Status>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy || !status?.configured) return;
    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const confirmed = state.bookings.filter((b) => b.status === "confirmed");
      const context = {
        bookings: confirmed.slice(0, 20).map((b) => ({ id: b.id, service: b.service, resource: b.resource, date: b.date, time: b.time, customer: b.customer })),
        totals: { confirmed: confirmed.length, cancelled: state.bookings.length - confirmed.length, auditEntries: state.audit.length },
      };
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, context }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setMessages([...next, { role: "assistant", content: data.error ?? `Request failed (${res.status}).` }]);
        return;
      }
      // Stream the reply token-by-token.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reply = "";
      setBusy(false);
      setMessages([...next, { role: "assistant", content: "" }]);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        setMessages([...next, { role: "assistant", content: reply }]);
      }
      reply += decoder.decode();
      setMessages([...next, { role: "assistant", content: reply.trim() || "No response." }]);
    } catch (e) {
      setMessages([...next, { role: "assistant", content: `Request failed: ${String(e)}` }]);
    } finally {
      setBusy(false);
    }
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
              {status === null ? "checking backend…" : status.configured ? `connected · ${status.model}` : "backend not connected"}
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
                <code className="rounded bg-black/30 px-1 font-mono text-xs">AI_GATEWAY_API_KEY</code> in{" "}
                <code className="rounded bg-black/30 px-1 font-mono text-xs">.env.local</code>. Everything else in FlowOps works without it.
              </p>
            </div>
          )}
          {status?.configured && messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-slate-400">Ask about the FLOWOPS platform, the Agent Matrix, or the bookings in this browser.</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 hover:border-cyan-400/40 hover:text-white">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={clsx("max-w-[90%] whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-sm", m.role === "user" ? "ml-auto bg-cyan-500/15 text-cyan-50" : "bg-white/[0.04] text-slate-200")}>
              {m.content}
            </div>
          ))}
          {busy && <div className="w-16 animate-pulse rounded-xl bg-white/[0.04] px-3.5 py-2.5 text-sm text-slate-400">…</div>}
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
              placeholder={status?.configured ? "Ask FlowAI…" : "Assistant offline — AI Gateway not connected"}
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
