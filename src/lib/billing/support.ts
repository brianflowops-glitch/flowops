/**
 * Billing support contact: the one address every billing message points at (billing card, plan-change / cancel
 * stopgap answers from /api/billing/plan and /api/billing/cancel, docs/BILLING.md). Client-safe (no server imports).
 * Deliberately separate from the general site contact (CONTACT_EMAIL in components/marketing/site-chrome.tsx).
 */
export const BILLING_SUPPORT_EMAIL = "billing@flowopsagent.ai";
