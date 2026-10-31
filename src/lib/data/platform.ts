/** Static platform definitions taken from the FLOWOPS ChatGPT project notes. */

export type ModuleKey = "core" | "net" | "sec" | "biz" | "ai" | "connect" | "pulse";

export const MODULES: Record<ModuleKey, { name: string; tagline: string; color: string; ring: string; text: string }> = {
  core: { name: "FLOWOPS Core", tagline: "Orchestration & agent runtime", color: "bg-cyan-500", ring: "ring-cyan-500/30", text: "text-cyan-300" },
  net: { name: "FlowNet", tagline: "Network operations", color: "bg-sky-500", ring: "ring-sky-500/30", text: "text-sky-300" },
  sec: { name: "FlowSec", tagline: "Security operations", color: "bg-rose-500", ring: "ring-rose-500/30", text: "text-rose-300" },
  biz: { name: "FlowBiz", tagline: "Business operations & booking", color: "bg-amber-500", ring: "ring-amber-500/30", text: "text-amber-300" },
  ai: { name: "FlowAI", tagline: "AI engine (planner, reasoner, router)", color: "bg-violet-500", ring: "ring-violet-500/30", text: "text-violet-300" },
  connect: { name: "FlowConnect", tagline: "Integrations & connector SDK", color: "bg-emerald-500", ring: "ring-emerald-500/30", text: "text-emerald-300" },
  pulse: { name: "FlowPulse", tagline: "Monitoring & telemetry", color: "bg-fuchsia-500", ring: "ring-fuchsia-500/30", text: "text-fuchsia-300" },
};

export type AgentStatus = "active" | "simulated" | "planned";

export interface AgentDef {
  name: string;
  module: ModuleKey;
  role: string;
  status: AgentStatus;
  /** true when the name comes from Brian's notes; false for placeholder names filling the 24-slot matrix */
  fromNotes: boolean;
}

export const AGENTS: AgentDef[] = [
  // Named in the Agent Matrix branding
  { name: "CoreAI", module: "core", role: "Central orchestrator; routes events to agents", status: "planned", fromNotes: true },
  { name: "LogicAgent", module: "ai", role: "Planner / reasoner for multi-step tasks", status: "planned", fromNotes: true },
  { name: "FlowAgent", module: "core", role: "Workflow execution and pipeline control", status: "planned", fromNotes: true },
  { name: "LinkAgent", module: "connect", role: "Connector broker for third-party systems", status: "planned", fromNotes: true },
  { name: "OpsAgent", module: "core", role: "General IT / ops task automation", status: "planned", fromNotes: true },
  { name: "NetAgent", module: "net", role: "Routing, devices, traffic and VPN health", status: "planned", fromNotes: true },
  { name: "SecAgent", module: "sec", role: "IDS/IPS alerts, policy enforcement", status: "planned", fromNotes: true },
  { name: "BizAgent", module: "biz", role: "Broader business workflows and workforce (bookings already run via the active booking agents)", status: "planned", fromNotes: true },
  { name: "DataAgent", module: "ai", role: "Data quality and knowledge-base upkeep", status: "planned", fromNotes: true },
  { name: "ComplianceAgent", module: "sec", role: "Policy & compliance evidence collection", status: "planned", fromNotes: true },
  { name: "IncidentAgent", module: "pulse", role: "Incident triage and escalation", status: "planned", fromNotes: true },
  { name: "PredictAgent", module: "pulse", role: "Forecasting and anomaly prediction", status: "planned", fromNotes: true },
  // Booking Engine pipeline (implemented in this app)
  { name: "IntentAgent", module: "biz", role: "Parses and validates booking intent", status: "active", fromNotes: true },
  { name: "BookingAgent", module: "biz", role: "Issues booking ID and status", status: "active", fromNotes: true },
  { name: "AvailabilityAgent", module: "biz", role: "Resource availability & conflict detection", status: "active", fromNotes: true },
  { name: "CalendarAgent", module: "connect", role: "Creates, updates and deletes Google Calendar events for connected calendars", status: "active", fromNotes: true },
  { name: "NotificationAgent", module: "connect", role: "Email confirmations and reminders are live; SMS texts are coming after carrier approval", status: "active", fromNotes: true },
  { name: "AuditAgent", module: "core", role: "Immutable audit trail", status: "active", fromNotes: true },
  // Placeholder names to fill the proposed 24-agent matrix (not named in the notes)
  { name: "RouteAgent", module: "net", role: "Routing table and path optimisation", status: "planned", fromNotes: false },
  { name: "ThreatAgent", module: "sec", role: "Threat intel enrichment (EDR feeds)", status: "planned", fromNotes: false },
  { name: "PolicyAgent", module: "sec", role: "OPA / Casbin policy decisions", status: "planned", fromNotes: false },
  { name: "PulseAgent", module: "pulse", role: "Telemetry collection (SNMP, syslog)", status: "planned", fromNotes: false },
  { name: "WorkforceAgent", module: "biz", role: "Shift and workforce scheduling", status: "planned", fromNotes: false },
  { name: "TravelAgent", module: "biz", role: "Travel and restaurant reservations", status: "planned", fromNotes: false },
];

export const NAV = [
  { href: "/", label: "Command Center", icon: "LayoutDashboard" },
  { href: "/agents", label: "Agent Matrix", icon: "Grid3x3" },
  { href: "/booking", label: "Booking Center", icon: "CalendarCheck" },
  { href: "/automation", label: "Automation Center", icon: "Workflow" },
  { href: "/network", label: "Network Operations", icon: "Network" },
  { href: "/security", label: "Security Center", icon: "ShieldCheck" },
  { href: "/testing", label: "Testing Lab", icon: "FlaskConical" },
  { href: "/analytics", label: "Analytics", icon: "BarChart3" },
  { href: "/integrations", label: "Integrations", icon: "Plug" },
  { href: "/admin", label: "Administration", icon: "Settings" },
] as const;

export const PHASES = [
  { id: "P1", dates: "Oct 24–25", title: "Booking Agent architecture" },
  { id: "P2", dates: "Oct 26–27", title: "Calendar integration testing" },
  { id: "P3", dates: "Oct 28–29", title: "Booking automation workflows" },
  { id: "P4", dates: "Oct 30–31", title: "Agent-to-agent communication" },
  { id: "P5", dates: "Nov 1–2", title: "End-to-end testing" },
  { id: "P6", dates: "Nov 3", title: "Results review & UI planning" },
];

/** Administration > Roadmap card. Customer-facing: no internal IDs, costs or secrets. */
export type RoadmapItem = { item: string; area: string; when?: string };

export const ROADMAP_SHIPPED: RoadmapItem[] = [
  { item: "Saved bookings and history in a real database", area: "Data" },
  { item: "Sign-in, roles (Owner, Admin, Staff) and separate workspaces per business", area: "Security" },
  { item: "Public booking page for your customers", area: "Booking" },
  { item: "Booking confirmation, change and cancellation emails", area: "Notifications" },
  { item: "Google Calendar sync for bookings", area: "Integrations" },
  { item: "FlowAI assistant live in the Command Center", area: "AI", when: "Oct 30" },
  { item: "Plans and billing: Starter, Pro and Business, add-ons, 14-day trial, in-app plan changes", area: "Billing", when: "Oct 30" },
  { item: "Email appointment reminders before each booking", area: "Notifications", when: "Oct 30" },
  { item: "Dedicated toll-free texting number and SMS opt-in page", area: "Messaging", when: "Oct 30" },
  { item: "Support and billing help at support@ and billing@flowopsagent.ai", area: "Support", when: "Oct 30" },
  { item: "Weekly automation counts on the Analytics page", area: "Analytics", when: "Oct 31" },
];

export const ROADMAP_UPCOMING: RoadmapItem[] = [
  { item: "Text message confirmations and reminders (after carrier approval)", area: "Messaging" },
  { item: "Agent-to-agent messaging over an event bus", area: "Agents" },
  { item: "Durable workflows for the Automation Center", area: "Automation" },
  { item: "FlowNet / FlowSec telemetry connectors (Firewalla, SNMP, syslog, EDR)", area: "Ops" },
  { item: "Vector memory (RAG) and policy context for FlowAI", area: "AI" },
  { item: "Public API and webhooks", area: "Platform" },
];
