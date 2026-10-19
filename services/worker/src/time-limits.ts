// How long a job handler waits for each service outside the worker before it gives up (packages/harness/src/time-limit.ts).
// Every limit sits well under the action queues' 15-minute job expiry, so a job gives up itself, with its rows already
// released, long before pg-boss would take it back: the five rounds of an AI turn at a minute each come to five minutes.
// What giving up does: a turn's job fails and pg-boss runs it again; a call or message whose answer never came is
// handed to a person and never sent again (src/sends.ts).
import { MODEL_TIME_LIMIT_MS } from "@revenue-os/harness";

export type TimeLimits = {
  model: number; // one answer from the AI model
  dialer: number; // the dialer taking a call
  whatsapp: number; // the WhatsApp service taking a message
  outcome: number; // a call's outcome
};

export const TIME_LIMITS: TimeLimits = {
  model: MODEL_TIME_LIMIT_MS,
  dialer: 15_000,
  whatsapp: 15_000,
  outcome: 15_000,
};
