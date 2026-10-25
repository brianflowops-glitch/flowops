/**
 * SAMPLE DATA — illustrative only. Nothing in this file comes from a real
 * system; every page that renders it shows a "Sample data — not connected" badge.
 */

export const SAMPLE_OPS_KPIS = [
  { label: "Monitored devices", value: "42", note: "FlowPulse" },
  { label: "Open incidents", value: "3", note: "IncidentAgent" },
  { label: "Security alerts (24h)", value: "17", note: "FlowSec" },
  { label: "Automations run (24h)", value: "128", note: "FlowAgent" },
];

export const SAMPLE_WORKFLOWS = [
  { name: "New booking → confirmation → reminder 24h", trigger: "Booking verified", steps: 4, status: "draft", runs: 0, module: "biz" },
  { name: "Reschedule → notify staff → update roster", trigger: "Booking rescheduled", steps: 3, status: "draft", runs: 0, module: "biz" },
  { name: "Critical alert → open ticket → page on-call", trigger: "FlowSec severity ≥ high", steps: 5, status: "design", runs: 0, module: "sec" },
  { name: "Device offline > 5 min → diagnose → notify", trigger: "FlowPulse heartbeat lost", steps: 4, status: "design", runs: 0, module: "pulse" },
  { name: "Weekly ops digest → Slack/Teams", trigger: "Schedule (Mon 08:00)", steps: 2, status: "idea", runs: 0, module: "core" },
];

export const SAMPLE_DEVICES = [
  { name: "fw-edge-01", type: "Firewalla Gold", site: "HQ", status: "online", cpu: 22, throughput: "312 Mbps" },
  { name: "sw-core-01", type: "Core switch", site: "HQ", status: "online", cpu: 14, throughput: "1.2 Gbps" },
  { name: "ap-floor-2", type: "Wi-Fi AP", site: "HQ", status: "degraded", cpu: 71, throughput: "88 Mbps" },
  { name: "fw-branch-01", type: "Firewalla Purple", site: "Branch", status: "online", cpu: 9, throughput: "64 Mbps" },
  { name: "nas-backup", type: "NAS", site: "HQ", status: "offline", cpu: 0, throughput: "—" },
];

export const SAMPLE_VPN = [
  { name: "HQ ⇄ Branch", status: "up", latency: "18 ms" },
  { name: "HQ ⇄ AWS us-east-1", status: "up", latency: "11 ms" },
  { name: "Remote users (WireGuard)", status: "up", latency: "—" },
];

export const SAMPLE_TRAFFIC = [38, 42, 35, 50, 61, 72, 68, 80, 77, 64, 58, 70, 83, 91, 76, 66, 59, 48, 44, 52, 57, 49, 41, 36];

export const SAMPLE_ALERTS = [
  { sev: "high", title: "Port scan from external host", source: "IDS (fw-edge-01)", time: "09:42", status: "open" },
  { sev: "medium", title: "Multiple failed admin logins", source: "Auth logs", time: "08:15", status: "investigating" },
  { sev: "low", title: "Outdated firmware on ap-floor-2", source: "Asset scan", time: "Yesterday", status: "open" },
  { sev: "medium", title: "DNS request to newly registered domain", source: "DNS filter", time: "Yesterday", status: "resolved" },
];

export const SAMPLE_POLICIES = [
  { name: "Block inbound RDP/SMB", engine: "Firewall", state: "enforced" },
  { name: "Admin actions require MFA", engine: "OPA (planned)", state: "draft" },
  { name: "Booking data retention 365d", engine: "Casbin (planned)", state: "draft" },
  { name: "Geo-block high-risk regions", engine: "Firewall", state: "monitor" },
];

export const SAMPLE_USERS = [
  { name: "Brian C.", email: "owner@flowops (sample)", role: "Owner", tenant: "FlowOps" },
  { name: "Ryan", email: "agent@flowops (sample)", role: "Builder (AI)", tenant: "FlowOps" },
  { name: "Ops Analyst", email: "analyst@example.com", role: "Operator", tenant: "Demo Tenant" },
  { name: "Viewer", email: "viewer@example.com", role: "Read-only", tenant: "Demo Tenant" },
];

export const SAMPLE_TENANTS = [
  { name: "FlowOps", plan: "Enterprise", seats: 5 },
  { name: "Demo Tenant", plan: "Starter", seats: 3 },
  { name: "MSP Sandbox", plan: "MSP Edition", seats: 10 },
];
