import type { Role } from "@/lib/server/context";

/**
 * FlowAI authorization policy: which roles may use each assistant tool, and whether the
 * signed-in user must approve the call in the UI before it runs.
 *
 * Kept in line with the dashboard API (every member may manage bookings; settings, services and
 * team management are Owner/Admin-only and are deliberately NOT exposed to FlowAI at all).
 * Any tool missing from this table is denied for everyone (default-deny), so a new FlowAI
 * action can't ship without an explicit role + approval decision.
 */
export type ToolKind = "read" | "write" | "destructive";
export interface ToolPolicy {
  kind: ToolKind;
  roles: readonly Role[];
  /** Mutating tools contact customers (email/SMS/calendar), so the user confirms each one. */
  needsApproval: boolean;
}

const ALL: readonly Role[] = ["owner", "admin", "staff"];

export const FLOWAI_POLICY = {
  listServices: { kind: "read", roles: ALL, needsApproval: false },
  listBookings: { kind: "read", roles: ALL, needsApproval: false },
  checkAvailability: { kind: "read", roles: ALL, needsApproval: false },
  createBooking: { kind: "write", roles: ALL, needsApproval: true },
  rescheduleBooking: { kind: "write", roles: ALL, needsApproval: true },
  cancelBooking: { kind: "destructive", roles: ALL, needsApproval: true },
} as const satisfies Record<string, ToolPolicy>;

export type FlowAiTool = keyof typeof FLOWAI_POLICY;

export function flowAiPolicy(tool: string): ToolPolicy | null {
  return (FLOWAI_POLICY as Record<string, ToolPolicy>)[tool] ?? null;
}

/** May `role` use `tool` at all? Unknown tools → false. */
export function canUseFlowAiTool(role: Role, tool: string) {
  const p = flowAiPolicy(tool);
  return Boolean(p && p.roles.includes(role));
}

/** Must this call be approved in the UI? Unknown tools → true (and they're denied anyway). */
export function flowAiNeedsApproval(tool: string) {
  const p = flowAiPolicy(tool);
  return !p || p.needsApproval || p.kind !== "read";
}

export class FlowAiForbidden extends Error {
  constructor(public tool: string, public role: Role) {
    super(`Your role (${role}) can't use ${tool}.`);
  }
}
