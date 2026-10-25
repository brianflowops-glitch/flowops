export type ServiceCategory = "appointment" | "travel" | "restaurant" | "workforce";

export type PipelineAgent =
  | "IntentAgent"
  | "BookingAgent"
  | "AvailabilityAgent"
  | "CalendarAgent"
  | "NotificationAgent"
  | "AuditAgent";

export type BookingStatus = "confirmed" | "cancelled";

export interface BookingRequest {
  customer: string;
  email: string;
  category: ServiceCategory;
  service: string;
  resource: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (24h)
  durationMin: number;
  notes?: string;
}

export interface Booking extends BookingRequest {
  id: string;
  status: BookingStatus;
  calendarEventId: string | null;
  createdAt: string;
  updatedAt: string;
  history: { at: string; action: string; detail: string }[];
}

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface AgentStep {
  agent: PipelineAgent;
  status: StepStatus;
  message: string;
  simulated: boolean;
  durationMs: number;
  output?: Record<string, unknown>;
}

export type PipelineAction = "create" | "reschedule" | "cancel";

export interface PipelineResult {
  action: PipelineAction;
  ok: boolean;
  verified: boolean;
  outcome: "verified" | "conflict" | "invalid" | "failed" | "not_found";
  booking: Booking | null;
  steps: AgentStep[];
  error?: string;
  suggestion?: { date: string; time: string };
}

export interface AuditEntry {
  id: string;
  at: string;
  action: PipelineAction | "agent_failure";
  bookingId: string | null;
  agent: PipelineAgent;
  outcome: "success" | "conflict" | "invalid" | "failed" | "not_found";
  detail: string;
}

export interface NotificationRecord {
  id: string;
  at: string;
  bookingId: string;
  recipient: string;
  channel: "email (simulated)";
  subject: string;
  deliveryStatus: "simulated-sent";
}

export interface EngineState {
  bookings: Booking[];
  audit: AuditEntry[];
  notifications: NotificationRecord[];
}

export interface RunOptions {
  /** Force this agent to throw, to exercise failure handling (FL-006). */
  failAgent?: PipelineAgent;
  /** Artificial delay per step so the UI can animate progress. */
  stepDelayMs?: number;
  /** Called every time a step changes state. */
  onStep?: (steps: AgentStep[]) => void;
  /** Override "now" (used by tests). */
  now?: Date;
}
