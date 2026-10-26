export type IntegrationStatus = "planned" | "next" | "simulated" | "deploy-target";

export const INTEGRATIONS: { name: string; category: string; module: string; status: IntegrationStatus; note: string }[] = [
  { name: "Google Calendar", category: "Calendar", module: "FlowConnect", status: "next", note: "Phase 2 (Oct 26–27): test calendar for Calendar Agent" },
  { name: "Gmail", category: "Email", module: "FlowConnect", status: "planned", note: "Real Notification Agent delivery" },
  { name: "Google Drive", category: "Storage", module: "FlowConnect", status: "planned", note: "Docs, playbooks, exports" },
  { name: "Microsoft 365", category: "Workspace", module: "FlowConnect", status: "planned", note: "Outlook calendar, Teams" },
  { name: "Slack", category: "Chat", module: "FlowConnect", status: "planned", note: "Alerts and digests" },
  { name: "Microsoft Teams", category: "Chat", module: "FlowConnect", status: "planned", note: "Alerts and digests" },
  { name: "AWS / Azure / GCP", category: "Cloud", module: "FlowPulse", status: "planned", note: "Cloud inventory & cost signals" },
  { name: "Firewalla", category: "Network", module: "FlowNet", status: "planned", note: "Devices, flows, VPN" },
  { name: "Jira / ServiceNow / Asana", category: "ITSM", module: "FlowConnect", status: "planned", note: "Tickets from incidents" },
  { name: "CrowdStrike / SentinelOne", category: "EDR", module: "FlowSec", status: "planned", note: "Endpoint threat feeds" },
  { name: "Datadog / Grafana / Zabbix", category: "Observability", module: "FlowPulse", status: "planned", note: "Metrics & alert ingestion" },
  { name: "Vercel AI Gateway", category: "LLM", module: "FlowAI", status: "deploy-target", note: "Powers the FlowAI Assistant (OIDC, no stored key)" },
  { name: "Postgres", category: "Database", module: "FLOWOPS Core", status: "planned", note: "Replace in-browser booking store" },
  { name: "Vercel", category: "Hosting", module: "Platform", status: "deploy-target", note: "Team Flowops (flowopsagent)" },
];
