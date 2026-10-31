"use client";

import { useState } from "react";
import { Bot } from "lucide-react";
import { AGENTS, MODULES, type ModuleKey } from "@/lib/data/platform";
import { Card, PageHeader, Pill } from "../ui";
import { clsx } from "../clsx";

const MODEL = [
  { name: "Input / Event", desc: "Requests, alerts, schedules" },
  { name: "Context Builder", desc: "RAG · policy · telemetry" },
  { name: "Agent Brain", desc: "Planner · Reasoner · Tool Router · Validator" },
  { name: "Execution Layer", desc: "Connectors, workflows, actions" },
  { name: "Learning Layer", desc: "Outcomes → memory & rules" },
];

export function AgentMatrix() {
  const [mod, setMod] = useState<ModuleKey | "all">("all");
  const list = AGENTS.filter((a) => mod === "all" || a.module === mod);
  const counts = {
    active: AGENTS.filter((a) => a.status === "active").length,
    simulated: AGENTS.filter((a) => a.status === "simulated").length,
    planned: AGENTS.filter((a) => a.status === "planned").length,
  };

  return (
    <div>
      <PageHeader
        kicker="FLOWOPS Agent Matrix"
        title="Agent Matrix"
        description={`${AGENTS.length} proposed agents across the seven modules. ${counts.active} run today inside the Booking Engine${counts.simulated ? `, ${counts.simulated} are simulated` : ""}, ${counts.planned} are planned.`}
      >
        <Pill status="active">{counts.active} active</Pill>
        {counts.simulated > 0 && <Pill status="simulated">{counts.simulated} simulated</Pill>}
        <Pill status="planned">{counts.planned} planned</Pill>
      </PageHeader>

      <Card className="mb-5" title="Agent system model" subtitle="How every FLOWOPS agent is structured">
        <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
          {MODEL.map((m, i) => (
            <div key={m.name} className="flex flex-1 items-center gap-2">
              <div className="flex-1 rounded-lg border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-transparent p-3">
                <p className="font-mono text-[10px] text-slate-600">L{i + 1}</p>
                <p className="text-sm font-medium text-slate-100">{m.name}</p>
                <p className="text-[11px] text-slate-500">{m.desc}</p>
              </div>
              {i < MODEL.length - 1 && <span className="hidden text-slate-600 md:block">→</span>}
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <FilterBtn active={mod === "all"} onClick={() => setMod("all")}>
          All modules
        </FilterBtn>
        {(Object.keys(MODULES) as ModuleKey[]).map((k) => (
          <FilterBtn key={k} active={mod === k} onClick={() => setMod(k)}>
            <span className={clsx("mr-1.5 inline-block h-1.5 w-1.5 rounded-full", MODULES[k].color)} />
            {MODULES[k].name}
          </FilterBtn>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {list.map((a) => {
          const m = MODULES[a.module];
          return (
            <div
              key={a.name}
              className={clsx(
                "group relative overflow-hidden rounded-xl border bg-[#0d1424]/80 p-4 transition hover:-translate-y-0.5",
                a.status === "active" ? "border-emerald-400/25" : a.status === "simulated" ? "border-violet-400/25" : "border-white/[0.07]",
              )}
            >
              <div className={clsx("absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-20 blur-2xl", m.color)} />
              <div className="flex items-center gap-2.5">
                <div className={clsx("grid h-9 w-9 place-items-center rounded-lg ring-1 ring-inset", m.ring, "bg-white/[0.03]")}>
                  <Bot className={clsx("h-4.5 w-4.5", m.text)} />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-white">{a.name}</p>
                  <p className={clsx("text-[11px]", m.text)}>{m.name}</p>
                </div>
                <span className="ml-auto">
                  <Pill status={a.status} />
                </span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-400">{a.role}</p>
              {!a.fromNotes && <p className="mt-2 font-mono text-[10px] text-slate-600">placeholder name — not yet named in plan</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("inline-flex items-center rounded-full border px-3 py-1 text-xs transition", active ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/[0.08] text-slate-400 hover:text-slate-200")}>
      {children}
    </button>
  );
}
