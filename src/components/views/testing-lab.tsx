"use client";

import { useState } from "react";
import { CheckCircle2, ChevronDown, CircleDashed, FlaskConical, Loader2, Play, XCircle } from "lucide-react";
import { TEST_CASES, runTest, type TestResult } from "@/lib/booking/tests";
import { Card, PageHeader, Pill, Stat } from "../ui";
import { clsx } from "../clsx";

const STRATEGY = [
  { phase: "1", title: "Simulation", desc: "Pipeline logic against an in-memory engine (this page).", status: "active" },
  { phase: "2", title: "Google Calendar test calendar", desc: "Calendar Agent against a dedicated test calendar (P2, Oct 26–27).", status: "next" },
  { phase: "3", title: "End-to-end", desc: "Full flow with real notifications and persistence (P5, Nov 1–2).", status: "planned" },
];

export function TestingLab() {
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  async function runAll() {
    setResults({});
    for (const t of TEST_CASES) {
      setRunning(t.id);
      await new Promise((r) => setTimeout(r, 180));
      const r = await runTest(t);
      setResults((prev) => ({ ...prev, [t.id]: r }));
    }
    setRunning(null);
    setLastRun(new Date().toLocaleTimeString());
  }

  async function runOne(id: string) {
    const t = TEST_CASES.find((x) => x.id === id)!;
    setRunning(id);
    const r = await runTest(t);
    setResults((prev) => ({ ...prev, [id]: r }));
    setRunning(null);
    setOpen(id);
  }

  const done = Object.values(results);
  const passed = done.filter((r) => r.pass).length;
  const failed = done.length - passed;

  return (
    <div>
      <PageHeader
        kicker="FLOWOPS Core · QA"
        title="Testing Lab"
        description="Simulation suite FL-001 … FL-007 from Phase 1. Each test runs the real TypeScript booking pipeline in your browser against an isolated sandbox engine — your Booking Center data is never touched."
      >
        <button
          onClick={runAll}
          disabled={!!running}
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-cyan-400 px-4 py-2 text-sm font-semibold text-[#04121a] hover:brightness-110 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? `Running ${running}…` : "Run all tests"}
        </button>
      </PageHeader>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Test cases" value={TEST_CASES.length} note="FL-001 … FL-007" tone="slate" />
        <Stat label="Passed" value={done.length ? passed : "—"} tone="emerald" note={lastRun ? `last run ${lastRun}` : "not run yet"} />
        <Stat label="Failed" value={done.length ? failed : "—"} tone={failed ? "rose" : "slate"} />
        <Stat label="Mode" value="SIM" tone="violet" note="simulation logic only" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <Card title="Simulation suite" subtitle="Click a row to see its assertions">
          <ul className="divide-y divide-white/[0.05]">
            {TEST_CASES.map((t) => {
              const r = results[t.id];
              const isRunning = running === t.id;
              return (
                <li key={t.id}>
                  <div className="flex cursor-pointer items-center gap-3 px-1 py-3" onClick={() => r && setOpen(open === t.id ? null : t.id)}>
                    {isRunning ? (
                      <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
                    ) : r ? (
                      r.pass ? <CheckCircle2 className="h-5 w-5 text-emerald-400" /> : <XCircle className="h-5 w-5 text-rose-400" />
                    ) : (
                      <CircleDashed className="h-5 w-5 text-slate-600" />
                    )}
                    <span className="w-16 font-mono text-xs text-cyan-300">{t.id}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-100">{t.name}</p>
                      <p className="text-xs text-slate-500">{t.description}</p>
                    </div>
                    {r && <span className="font-mono text-[10.5px] text-slate-600">{r.durationMs}ms</span>}
                    {r ? <Pill status={r.pass ? "pass" : "fail"} /> : <Pill status="pending">not run</Pill>}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        runOne(t.id);
                      }}
                      disabled={!!running}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-white/5 hover:text-cyan-300 disabled:opacity-30"
                      title={`Run ${t.id}`}
                    >
                      <Play className="h-3.5 w-3.5" />
                    </button>
                    <ChevronDown className={clsx("h-4 w-4 text-slate-600 transition", open === t.id && "rotate-180", !r && "opacity-0")} />
                  </div>
                  {r && open === t.id && (
                    <ul className="mb-3 ml-8 space-y-1 rounded-lg border border-white/[0.05] bg-black/20 p-3">
                      {r.assertions.map((a, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          {a.pass ? <CheckCircle2 className="mt-px h-3.5 w-3.5 text-emerald-400" /> : <XCircle className="mt-px h-3.5 w-3.5 text-rose-400" />}
                          <span className="text-slate-300">{a.label}</span>
                          {a.detail && <span className="truncate font-mono text-slate-600">[{a.detail}]</span>}
                        </li>
                      ))}
                      {r.error && <li className="text-xs text-rose-300">{r.error}</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="space-y-5">
          <Card title="Testing strategy C" subtitle="Approved in Phase 1 kickoff">
            <ol className="space-y-3">
              {STRATEGY.map((s) => (
                <li key={s.phase} className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 font-mono text-[11px] text-slate-300">{s.phase}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-slate-100">{s.title}</p>
                      <Pill status={s.status} />
                    </div>
                    <p className="text-xs text-slate-500">{s.desc}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
          <Card title="About these results">
            <div className="flex gap-3 text-xs leading-relaxed text-slate-400">
              <FlaskConical className="h-4 w-4 shrink-0 text-violet-300" />
              <p>
                Results reflect simulation logic only. Calendar and Notification agents are simulated, so a pass here does not prove Google Calendar or email delivery works — that is Phase 2 and Phase 5. Run the same suite from a terminal with <code className="font-mono text-slate-300">npm test</code>.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
