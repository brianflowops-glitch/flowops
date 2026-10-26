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
  /** Optional customer phone (used for SMS notifications when Twilio is configured). */
  phone?: string;
  /** Customer opted in to appointment texts (public booking checkbox / staff-confirmed). SMS is only sent when true. */
  smsConsent?: boolean;
}

export interface Booking extends BookingRequest {
  id: string;
  status: BookingStatus;
  calendarEventId: string | null;
  createdAt: string;
  updatedAt: string;
  history: { at: string; action: string; detail: string }[];
  /** When the customer opted in to texts (ISO), kept as the consent record for carrier (A2P 10DLC) compliance. */
  smsConsentAt?: string;
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
  actor?: string;
}

export interface NotificationRecord {
  id: string;
  at: string;
  bookingId: string;
  recipient: string;
  channel: "email (simulated)" | "sms (simulated)" | "email" | "sms";
  subject: string;
  deliveryStatus: "simulated-sent" | "queued" | "sent" | "failed";
  detail?: string;
}

export interface EngineState {
  bookings: Booking[];
  audit: AuditEntry[];
  notifications: NotificationRecord[];
}

/** Opening hours for one day, HH:MM 24h. `null` = closed. */
export type DayHours = { open: string; close: string } | null;

/** Real Calendar Agent backend (e.g. Google Calendar). Absent = simulated. */
export interface CalendarAdapter {
  label: string;
  create(b: Booking): Promise<string>;
  update(b: Booking): Promise<string>;
  remove(eventId: string): Promise<void>;
}

/** Real Notification Agent backend (e.g. Resend email, Twilio SMS). Absent = simulated. */
export interface NotifierAdapter {
  /** Channels that are real; any channel not listed stays simulated. */
  channels: { email: boolean; sms: boolean };
  send(b: Booking, subject: string, body: string, channel: "email" | "sms"): Promise<{ ok: boolean; detail?: string }>;
}

export interface RunOptions {
  /** Business hours lookup for a date (YYYY-MM-DD). Default: 07:00–22:00 every day. */
  hoursFor?: (date: string) => DayHours;
  /** IANA time zone used for the "in the past" check. Default: the process' local time. */
  timeZone?: string;
  calendar?: CalendarAdapter;
  notifier?: NotifierAdapter;
  /** Recorded on audit entries (who triggered the run). */
  actor?: string;
  /** Force this agent to throw, to exercise failure handling (FL-006). */
  failAgent?: PipelineAgent;
  /** Artificial delay per step so the UI can animate progress. */
  stepDelayMs?: number;
  /** Called every time a step changes state. */
  onStep?: (steps: AgentStep[]) => void;
  /** Override "now" (used by tests). */
  now?: Date;
}

/** Business hours by weekday, "0" = Sunday … "6" = Saturday. */
export type WeekHoursClient = Record<"0" | "1" | "2" | "3" | "4" | "5" | "6", DayHours>;
