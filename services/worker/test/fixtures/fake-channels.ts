// Synthetic providers for the multi-day replay (m2-replay.test.ts): FakeVoice (Vapi), FakeWa (Meta), a
// scripted fake LLM, and a guard SPY. No real telephony, no real network, no ANTHROPIC_API_KEY.
// These stand in for the worker's stand-in senders (services/worker/src/jobs.ts) so the handlers run against
// deterministic effects while every real invariant (guard-before-send, provider_ref uniqueness,
// runTurn metering) still fires. G1-friendly (Intl/Date only) — but lives under services/, not a
// package, so bun:* would be legal here; it needs none.
import { randomUUID } from "node:crypto";
import {
  type GuardedAction,
  guard,
  type LlmProvider,
  type LlmTurn,
  type OrgCtx,
  type Verdict,
} from "@revenue-os/harness";
import type {
  OutcomePort,
  VoiceSenderPort,
} from "../../src/handlers/place-call";
import type { WaSenderPort } from "../../src/handlers/send-wa";
import type { SimClock } from "./sim-clock";

// Module-level counters for globally-unique provider refs (prevents test-isolation collisions
// where each test fixture instance would restart counting at 1, causing provider_ref duplicates),
// behind a tag of this run's own: provider refs are unique across every company, so two test runs
// at once on the shared database must not both send `vapi-call-1`.
const RUN = randomUUID().slice(0, 8);
let voiceSeq = 0;
let waSeq = 0;

/**
 * A scripted LlmProvider: returns turns[i] then advances, holding the LAST turn once exhausted
 * (the loop.test idiom, as place-call.test.ts and agent-turn.test.ts use it). runTurn stops the moment a turn has no toolCalls, so a
 * call that must BOOK scripts [bookToolCall, closingText] and a no-answer call scripts [text].
 */
export function makeScriptedLlm(turns: LlmTurn[]): LlmProvider {
  let i = 0;
  return {
    complete: async () => {
      const t = turns[Math.min(i, turns.length - 1)];
      if (!t) throw new Error("scripted LLM: no turns supplied");
      i += 1;
      return t;
    },
  };
}

/** FakeVoice — the Vapi VoiceSender + the call-outcome port behind ONE object. place() mints a
 *  UNIQUE providerRef (so two calls never collide on convo_provider_ref_uq) and is paired 1:1 with
 *  outcome(), which replays the scripted disposition for that call (no_answer #1, completed #2). The
 *  pairing is exact because a place_call handler calls place() then outcome() once each, serially.
 *  Provider refs use a global counter to avoid collisions across test instances; outcome pairing
 *  stays per-instance (each instance tracks its own placement count for disposition indexing). */
export function makeFakeVoice(dispositions: string[]): {
  refs: string[];
  readonly placeCount: number;
  place: VoiceSenderPort["place"];
  outcome: OutcomePort;
} {
  const refs: string[] = [];
  let placed = 0;
  const place: VoiceSenderPort["place"] = async () => {
    voiceSeq += 1;
    placed += 1;
    const providerRef = `vapi-call-${RUN}-${voiceSeq}`;
    refs.push(providerRef);
    return { providerRef };
  };
  const outcome: OutcomePort = async () => {
    const d = dispositions[placed - 1];
    if (d === undefined)
      throw new Error("fake voice: no scripted disposition for this call");
    return d;
  };
  return {
    refs,
    get placeCount() {
      return placed;
    },
    place,
    outcome,
  };
}

/** FakeWa — the Meta WaSender. send() mints a unique wamid (delivered) and counts.
 *  Like FakeVoice, wamids use a global counter to avoid cross-test collisions. */
export function makeFakeWa(): {
  refs: string[];
  readonly sendCount: number;
  send: WaSenderPort["send"];
} {
  const refs: string[] = [];
  let sent = 0;
  const send: WaSenderPort["send"] = async () => {
    waSeq += 1;
    sent += 1;
    const providerRef = `wamid-${RUN}-${waSeq}`;
    refs.push(providerRef);
    return { providerRef };
  };
  return {
    refs,
    get sendCount() {
      return sent;
    },
    send,
  };
}

export type GuardCall = { channel?: string; ok: boolean };

/**
 * A guard SPY that proves guardrails run before every send (no send bypasses guard) without faking the verdict: it delegates
 * to the REAL @revenue-os/harness `guard` (the seeded quiet_hours / attempt_caps / dnc pipeline),
 * injecting the SimClock as ctx.now so the window checks read simulated time — not the CI wall clock
 * (which would make quiet-hours nondeterministic). Every doorway send passes through `fn` before the
 * sender, so `calls` is the complete, unfakeable ledger of what the guard saw.
 */
export function makeGuardSpy(clock: SimClock): {
  fn: (ctx: OrgCtx, action: GuardedAction) => Promise<Verdict>;
  calls: GuardCall[];
} {
  const calls: GuardCall[] = [];
  const fn = async (ctx: OrgCtx, action: GuardedAction): Promise<Verdict> => {
    const verdict = await guard({ ...ctx, now: () => clock.now() }, action);
    calls.push({ channel: action.channel, ok: verdict.ok });
    return verdict;
  };
  return { fn, calls };
}
