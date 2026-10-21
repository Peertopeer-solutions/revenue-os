// The pure workflow interpreter, the step map that drives a sequence (docs/tech-stack.md T26.2).
//
//   interpret(definition, runState, event, now) → Transition
//
// PURE by contract (test 9): deterministic in its four inputs, performs ZERO I/O, and never
// reads the clock — callers pass `now` explicitly. No db/ctx handle is in the signature, so
// durability lives entirely in the tables, never here. Guardrail checks are NOT here (they run
// per-action in the executor). G1: runtime-agnostic (Intl only — no date libs, no Bun globals).
import {
  type Action,
  TaskContentSchema,
  type Transition,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowState,
} from "./schema";

// --- pure helpers -----------------------------------------------------------

// ISO-8601 duration → milliseconds, for `wait` steps. Supports weeks/days and the T-part
// hours/minutes/seconds (the fixed-length fields a wait expresses); calendar-ambiguous
// years/months are rejected.
const DURATION =
  /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
function durationMs(iso: string): number {
  const m = DURATION.exec(iso);
  if (!m || iso === "P" || iso === "PT") {
    throw new Error(`unsupported ISO-8601 duration: ${iso}`);
  }
  const [, w, d, h, min, s] = m;
  const secs =
    Number(w ?? 0) * 604800 +
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Number(s ?? 0);
  return secs * 1000;
}

// Wall-clock parts of an instant read IN `tz` (via Intl — host-tz independent, like quiet-hours).
function zonedParts(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const at = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: at("year"),
    month: at("month"),
    day: at("day"),
    hour: at("hour"),
    minute: at("minute"),
    second: at("second"),
  };
}

// Author-owned task content, validated at the PRODUCER of the action. A payload the DB would
// reject throws here, so the scheduler dead-letters the run in phase 1 (operator-visible) instead
// of rolling back the apply phase every tick forever.
function taskContent(
  id: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const parsed = TaskContentSchema.safeParse(args);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((i) => `${i.path.join(".") || "args"}: ${i.message}`)
    .join("; ");
  throw new Error(`invalid create_task args at step ${id}: ${issues}`);
}

// The next instant whose wall-clock in `tz` is exactly hh:mm:00, STRICTLY after `now`.
// ponytail: single-pass offset — exact for fixed-offset zones (Asia/Kolkata); inside a DST
// spring-forward gap it can be off by the DST delta. Two-pass converge if that ever matters.
function nextLocalTime(now: Date, hhmm: string, tz: string): Date {
  const [h = 0, min = 0] = hhmm.split(":").map(Number);
  const { year, month, day } = zonedParts(now, tz);
  const utcAt = (d: number): Date => {
    const naive = Date.UTC(year, month - 1, d, h, min, 0);
    const z = zonedParts(new Date(naive), tz);
    const offset =
      Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second) - naive;
    return new Date(naive - offset);
  };
  const today = utcAt(day);
  return today.getTime() > now.getTime() ? today : utcAt(day + 1);
}

// The technical results a `call` step's `on` map names directly. Anything else the handler folds
// (interested, callback, or any disposition the company's own rows name) is a BUSINESS disposition —
// the call COMPLETED and carries it — so it routes via the `completed` arm and survives to a
// downstream `branch`.
const CALL_OUTCOMES = new Set(["completed", "no_answer", "busy", "failed"]);

// --- interpreter ------------------------------------------------------------

export function interpret(
  def: WorkflowDefinition,
  state: WorkflowState,
  _event: WorkflowEvent,
  now: Date,
): Transition {
  function run(id: string): Transition {
    const step = def.steps[id];
    if (!step) throw new Error(`unknown step: ${id}`);
    switch (step.kind) {
      case "call": {
        // RE-ENTRY: the handler folded in the call outcome → route, no side effect, chain on.
        const disposition = state.lastDisposition;
        if (disposition) {
          const on = step.on as Record<string, string>;
          // A named technical outcome routes directly. A business disposition the map does not name
          // routes as `completed` (the call was answered and qualified) and is carried forward by the
          // scheduler across a call→branch hop so the branch routes on the SAME disposition.
          const routed =
            on[disposition] ??
            (CALL_OUTCOMES.has(disposition) ? undefined : on.completed) ??
            null;
          return {
            actions: [],
            nextStep: routed,
            wakeAt: null,
            runStatus: "running",
          };
        }
        // FRESH entry: place the call and park on this step, waiting for the provider callback.
        // The unit tests cover RE-ENTRY only; this arm is exercised by the replay test
        // (services/worker/test/m2-replay.test.ts).
        const action: Action = {
          kind: "place_call",
          contactId: state.contactId ?? "",
          agentKey: step.agent as string,
        };
        return {
          actions: [action],
          nextStep: id,
          wakeAt: null,
          runStatus: "waiting",
        };
      }
      case "wait":
        return {
          actions: [],
          nextStep: step.then as string,
          wakeAt: new Date(now.getTime() + durationMs(step.for as string)),
          runStatus: "waiting",
        };
      case "wait_until":
        return {
          actions: [],
          nextStep: step.then as string,
          wakeAt: nextLocalTime(
            now,
            step.localTime as string,
            state.timezone ?? "UTC",
          ),
          runStatus: "waiting",
        };
      case "whatsapp": {
        // Emit the send AND arm the following step in the same tick (single transition).
        const action: Action = {
          kind: "send_wa",
          contactId: state.contactId ?? "",
          template: step.template as string,
          vars: (step.vars as Record<string, string> | undefined) ?? {},
        };
        const next = run(step.then as string);
        return { ...next, actions: [action, ...next.actions] };
      }
      case "branch": {
        // Pure routing on the folded-in disposition; unmatched falls through to the '*' arm.
        const arms = step.onDisposition as Record<string, string>;
        const disposition = state.lastDisposition;
        return {
          actions: [],
          nextStep:
            (disposition ? arms[disposition] : undefined) ?? arms["*"] ?? null,
          wakeAt: null,
          runStatus: "running",
        };
      }
      case "tool": {
        // Closed side-effect set: create_task drafts a task; book_appointment records an outcome,
        // named by the step's own `outcome` (a row of the company's sequence, as the seed packs
        // write it; the schema refuses a booking step without one). The Action kind and the
        // attribution contact are INTERPRETER-owned: `args` is spread FIRST so a definition can
        // never repoint an outcome at another tenant's contact (outcomes.contact_id is an FK, and
        // FK checks bypass RLS) or rename it through an args key.
        const target = step.then as string;
        const args = (step.args as Record<string, unknown> | undefined) ?? {};
        const action: Action =
          step.tool === "book_appointment"
            ? {
                kind: "write_outcome",
                outcome: {
                  ...args,
                  kind: step.outcome as string,
                  contactId: state.contactId,
                },
              }
            : { kind: "create_task", task: taskContent(id, args) };
        return {
          actions: [action],
          nextStep: target,
          wakeAt: null,
          runStatus: target === "end" ? "completed" : "running",
        };
      }
      case "end":
        return {
          actions: [],
          nextStep: null,
          wakeAt: null,
          runStatus: "completed",
        };
    }
  }

  return run(state.currentStep ?? def.entry);
}
