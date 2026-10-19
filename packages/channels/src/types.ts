// The guarded-doorway contract: voice(Vapi) + whatsapp(Meta) sends behind ONE shape, every
// send passing guard() BEFORE it reaches a sender (AGENTS.md hard rail 5 — no code path around the
// guard). Pure types only — no implementation. Harness types come in via the tsconfig `@harness/*`
// path alias (type-only, erased at runtime; no @revenue-os/harness runtime dep on this package).
// G1: runtime-agnostic — no bun:* imports, no Bun globals.
import type { Autonomy, GuardedAction, OrgCtx, Verdict } from "@harness/types";

/** Provider handle a real sender returns — the provider_ref later used to upsert webhook_events. */
export interface SendResult {
  providerRef: string;
}

/** Voice (Vapi) send payload — what VoiceSender.place dials. `to` is E.164 (normalized upstream). */
export interface VoicePayload {
  to: string;
  assistantId?: string;
  metadata?: Record<string, unknown>;
}

/** WhatsApp (Meta) send payload — template + the vars the send_wa job handler merged. `to` is E.164. */
export interface WaPayload {
  to: string;
  template: string;
  /** Template variables — the doorway FORWARDS these verbatim; the contact/run-var MERGE is the
   *  send_wa job handler's, not this doorway's (a send_wa message must never go out empty). */
  vars: Record<string, string>;
}

/** Injectable production senders (Vapi / Meta). Prod stubs are swapped in later; tests inject
 *  spies. NO live network is ever reached through these in tests. */
export interface VoiceSender {
  place(payload: VoicePayload): Promise<SendResult>;
}
export interface WaSender {
  send(payload: WaPayload): Promise<SendResult>;
}

/** Which company a send is for: all a doorway needs, as it never touches the database itself. */
export type SendCtx = Pick<OrgCtx, "orgId">;

/** The guard the doorway MUST call before any send (guardrails run before every send). Its caller gives it its
 *  database: the worker's job handlers run the real @revenue-os/harness `guard` in a short transaction of its own,
 *  so no transaction is open while the provider answers; tests inject a spy. */
export type GuardFn = (ctx: SendCtx, action: GuardedAction) => Promise<Verdict>;

/** Injected ports per doorway — sender + guard, both swappable. */
export interface VoicePorts {
  sender: VoiceSender;
  guard: GuardFn;
}
export interface WaPorts {
  sender: WaSender;
  guard: GuardFn;
}

/** Doorway request: the guard-relevant identity + the sender payload. `autonomy`/`toolName` come
 *  from the calling tool so the guard's autonomy/attempt bookkeeping is accurate. */
export interface VoiceReq {
  contactId: string;
  autonomy: Autonomy;
  toolName: string;
  payload: VoicePayload;
}
export interface WaReq {
  contactId: string;
  autonomy: Autonomy;
  toolName: string;
  payload: WaPayload;
}

/** A blocking verdict — the exact shape the doorway returns when guard denies the send. */
export type Blocked = Extract<Verdict, { ok: false }>;

/** Doorway result: the sender's result on an ok verdict, or the guard's blocking verdict. */
export type DoorwayResult = { ok: true; result: SendResult } | Blocked;
