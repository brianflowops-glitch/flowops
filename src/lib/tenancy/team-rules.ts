import type { Role } from "@/lib/server/context";

/** Who may invite which role: Owner → Admin or Staff; Admin → Staff. */
export function canInviteRole(actor: Role, role: "admin" | "staff") {
  if (actor === "owner") return true;
  if (actor === "admin") return role === "staff";
  return false;
}

/** Who may generate a reset link for whom (same org only — enforced by the caller). */
export function canResetFor(actor: { id: string; role: Role }, target: { userId: string; role: Role }) {
  if (actor.role === "staff") return false;
  if (actor.id === target.userId) return true;
  if (actor.role === "owner") return true;
  return target.role === "staff"; // admin → staff only
}

/** Who may remove whom. Owners are never removed here; nobody removes themselves. */
export function canRemove(actor: { id: string; role: Role }, target: { userId: string; role: Role }) {
  if (actor.role === "staff" || target.role === "owner" || actor.id === target.userId) return false;
  if (actor.role === "owner") return true;
  return target.role === "staff";
}
