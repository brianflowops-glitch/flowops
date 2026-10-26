import { Cpu, GitBranch, Lock, Plug, Server, ShieldAlert, Workflow } from "lucide-react";
import { INTEGRATIONS } from "@/lib/data/integrations";
import { MODULES, ROADMAP } from "@/lib/data/platform";
import {
  SAMPLE_ALERTS,
  SAMPLE_DEVICES,
  SAMPLE_POLICIES,
  SAMPLE_TRAFFIC,
  SAMPLE_VPN,
  SAMPLE_WORKFLOWS,
} from "@/lib/data/sample";
import { Card, PageHeader, Pill, SampleBadge, Table, Td } from "../ui";

function Planned({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i} className="flex items-start gap-2 text-xs text-slate-400">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/60" />
          {i}
        </li>
      ))}
    </ul>
  );
}

export function AutomationCenter() {
  return (
    <div>
      <PageHeader kicker="FLOWOPS Core · FlowAgent" title="Automation Center" description="Workflow automation that chains agents together. Phase 3 (Oct 28–29) builds the first booking automation workflows.">
        <SampleBadge />
      </PageHeader>
      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <Card title="Workflows" subtitle="Sample definitions — none are running">
          <Table head={["Workflow", "Trigger", "Steps", "Module", "Status", "Runs"]}>
            {SAMPLE_WORKFLOWS.map((w) => (
              <tr key={w.name}>
                <Td>
                  <span className="flex items-center gap-2 text-slate-100">
                    <Workflow className="h-4 w-4 text-cyan-300" /> {w.name}
                  </span>
                </Td>
                <Td className="text-xs text-slate-400">{w.trigger}</Td>
                <Td className="font-mono text-xs">{w.steps}</Td>
                <Td className="text-xs">{MODULES[w.module as keyof typeof MODULES].name}</Td>
                <Td>
                  <Pill status={w.status} />
                </Td>
                <Td className="font-mono text-xs text-slate-500">{w.runs}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Planned engine">
          <Planned
            items={[
              "Durable execution with Temporal or Prefect (retries, timers)",
              "Event bus triggers (NATS / Kafka / RabbitMQ)",
              "Agent-to-agent messaging (Phase 4, Oct 30–31)",
              "Natural-language workflow builder via FlowAI",
              "Approval steps for sensitive actions (OPA policies)",
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

export function NetworkOperations() {
  const max = Math.max(...SAMPLE_TRAFFIC);
  const pts = SAMPLE_TRAFFIC.map((v, i) => `${(i / (SAMPLE_TRAFFIC.length - 1)) * 100},${40 - (v / max) * 36}`).join(" ");
  return (
    <div>
      <PageHeader kicker="FlowNet · NetAgent" title="Network Operations" description="Routing, devices, traffic and VPN — powered by NetAgent once device telemetry (Firewalla, SNMP, syslog) is connected.">
        <SampleBadge />
      </PageHeader>
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Traffic — last 24h" subtitle="Sample curve, not real traffic">
          <svg viewBox="0 0 100 42" preserveAspectRatio="none" className="h-40 w-full">
            <defs>
              <linearGradient id="tg" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="rgb(56,189,248)" stopOpacity="0.35" />
                <stop offset="1" stopColor="rgb(56,189,248)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon points={`0,42 ${pts} 100,42`} fill="url(#tg)" />
            <polyline points={pts} fill="none" stroke="rgb(56,189,248)" strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
          </svg>
        </Card>
        <Card title="VPN tunnels" subtitle="Sample">
          <ul className="space-y-2">
            {SAMPLE_VPN.map((v) => (
              <li key={v.name} className="flex items-center justify-between rounded-lg border border-white/[0.05] px-3 py-2 text-sm">
                <span className="flex items-center gap-2 text-slate-200">
                  <GitBranch className="h-4 w-4 text-sky-300" /> {v.name}
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-slate-500">{v.latency}</span>
                  <Pill status={v.status} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="xl:col-span-2" title="Devices" subtitle="Sample inventory">
          <Table head={["Device", "Type", "Site", "CPU", "Throughput", "Status"]}>
            {SAMPLE_DEVICES.map((d) => (
              <tr key={d.name}>
                <Td>
                  <span className="flex items-center gap-2 font-mono text-xs text-slate-100">
                    <Server className="h-3.5 w-3.5 text-sky-300" />
                    {d.name}
                  </span>
                </Td>
                <Td className="text-xs">{d.type}</Td>
                <Td className="text-xs">{d.site}</Td>
                <Td>
                  <div className="h-1.5 w-20 rounded-full bg-white/[0.06]">
                    <div className={`h-full rounded-full ${d.cpu > 60 ? "bg-amber-400" : "bg-sky-400"}`} style={{ width: `${d.cpu}%` }} />
                  </div>
                </Td>
                <Td className="font-mono text-xs">{d.throughput}</Td>
                <Td>
                  <Pill status={d.status} />
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Planned integrations">
          <Planned items={["Firewalla devices & flows", "SNMP polling and syslog ingestion", "SSH sandbox for safe remediation", "Cloud networking (AWS / Azure / GCP)", "RouteAgent path optimisation"]} />
        </Card>
      </div>
    </div>
  );
}

export function SecurityCenter() {
  return (
    <div>
      <PageHeader kicker="FlowSec · SecAgent" title="Security Center" description="IDS/IPS alerts, policies and compliance. SecAgent and ComplianceAgent will triage once EDR and firewall feeds are connected.">
        <SampleBadge />
      </PageHeader>
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Alerts" subtitle="Sample alerts — not from a real sensor">
          <ul className="space-y-2">
            {SAMPLE_ALERTS.map((a) => (
              <li key={a.title} className="flex items-center gap-3 rounded-lg border border-white/[0.05] bg-white/[0.01] px-3 py-2.5">
                <ShieldAlert className={`h-4 w-4 ${a.sev === "high" ? "text-rose-400" : a.sev === "medium" ? "text-amber-400" : "text-sky-400"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-100">{a.title}</p>
                  <p className="text-[11px] text-slate-500">
                    {a.source} · {a.time}
                  </p>
                </div>
                <Pill status={a.sev} />
                <Pill status={a.status} />
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Policies" subtitle="Sample">
          <ul className="space-y-2">
            {SAMPLE_POLICIES.map((p) => (
              <li key={p.name} className="rounded-lg border border-white/[0.05] px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm text-slate-200">
                    <Lock className="h-3.5 w-3.5 text-rose-300" />
                    {p.name}
                  </span>
                  <Pill status={p.state} />
                </div>
                <p className="mt-0.5 pl-5 text-[11px] text-slate-500">{p.engine}</p>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="xl:col-span-3" title="Planned integrations">
          <div className="grid gap-4 md:grid-cols-3">
            <Planned items={["CrowdStrike / SentinelOne EDR feeds", "Firewalla IDS/IPS events"]} />
            <Planned items={["OPA / Casbin policy engine", "MFA enforcement for admin actions"]} />
            <Planned items={["IncidentAgent triage → Jira / ServiceNow", "Compliance evidence collection"]} />
          </div>
        </Card>
      </div>
    </div>
  );
}

export function IntegrationsPage() {
  const groups = ["next", "deploy-target", "planned"] as const;
  const label = { next: "Up next", "deploy-target": "Deployment", planned: "Planned" };
  return (
    <div>
      <PageHeader kicker="FlowConnect · LinkAgent" title="Integrations" description="Nothing is connected yet. In v1 the Calendar and Notification agents are simulated inside the Booking Engine; the AI Assistant runs on Vercel AI Gateway." />
      {groups.map((g) => (
        <div key={g} className="mb-6">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{label[g]}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {INTEGRATIONS.filter((i) => i.status === g).map((i) => (
              <div key={i.name} className="flex gap-3 rounded-xl border border-white/[0.07] bg-[#0d1424]/80 p-4">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.04] font-mono text-sm font-bold text-slate-300">{i.name.slice(0, 2)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium text-slate-100">{i.name}</p>
                    <span className="ml-auto">
                      <Pill status={i.status}>{i.status === "planned" ? "not connected" : i.status.replace("-", " ")}</Pill>
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    {i.category} · {i.module}
                  </p>
                  <p className="mt-1.5 text-xs text-slate-400">{i.note}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      <Card title="Connector SDK" subtitle="Planned">
        <div className="flex gap-3 text-xs text-slate-400">
          <Plug className="h-4 w-4 shrink-0 text-emerald-300" />
          <p>FlowConnect will expose a connector SDK and agent marketplace so partners can add integrations (REST / GraphQL, OAuth, webhooks) without changing FLOWOPS Core.</p>
        </div>
      </Card>
    </div>
  );
}

const TIERS = [
  { name: "Starter", for: "Small teams", features: ["Booking Engine", "Core dashboards", "Community support"] },
  { name: "Pro", for: "Growing ops teams", features: ["All modules", "Automation Center", "Standard integrations"] },
  { name: "Enterprise", for: "Large organisations", features: ["SSO & advanced policies", "Custom agents", "Hybrid / on-prem LLMs"] },
  { name: "MSP Edition", for: "Managed service providers", features: ["Multi-tenant console", "Per-tenant billing", "White-label"] },
];

/** Plans + roadmap (sample / planning content) shown under the real Administration settings. */
export function AdminPlans() {
  return (
    <div className="mt-5">
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-3" title="Plans" subtitle="Usage + seat hybrid pricing (from the business plan; prices not set)">
          <div className="grid gap-3 md:grid-cols-4">
            {TIERS.map((t) => (
              <div key={t.name} className="rounded-xl border border-white/[0.07] bg-white/[0.015] p-4">
                <p className="font-semibold text-white">{t.name}</p>
                <p className="mb-2 text-[11px] text-slate-500">{t.for}</p>
                <Planned items={t.features} />
              </div>
            ))}
          </div>
        </Card>
        <Card className="xl:col-span-3" title="Roadmap" subtitle="Next steps after v1">
          <div className="grid gap-2 md:grid-cols-3">
            {ROADMAP.map((r) => (
              <div key={r.item} className="flex items-start gap-2 rounded-lg border border-white/[0.05] px-3 py-2 text-xs text-slate-300">
                <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" />
                <span>
                  {r.item}
                  <span className="ml-1 text-slate-600">· {r.area}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
