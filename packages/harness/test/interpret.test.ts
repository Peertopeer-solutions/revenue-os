// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow step field in the
// definition JSON (docs/tech-stack.md T26.2; e.g. { kind:"wait", for:"PT2H", then:"..." }) — data, not a thenable.
// The workflow interpreter and definition schema (the step map that drives a sequence).
//
// Env-free and PURE: no DB, no pg-boss, no clock reads — every test passes a fixed `now`.
// These tests ENCODE the contract that the scheduler (services/worker/src/scheduler.ts) and the job handlers satisfy:
//
//   interpret(def, state, event, now) → Transition
//     Transition = { actions: Action[]; nextStep: string | null; wakeAt: Date | null; runStatus }
//
//   state (the interpreter's view of a workflow_run — see src/workflow/schema.ts):
//     { currentStep?, lastDisposition?, timezone?, contactId?, vars? }
//     • currentStep      — the step the run is parked on; absent ⇒ def.entry.
//     • lastDisposition  — routing signal the handler folds in before a wake: at a `call`
//                          step it is the call OUTCOME (completed|no_answer|busy|failed); at
//                          a `branch` step it is the DISPOSITION (qualified|callback|dnc|…).
//     • timezone         — IANA tz for wait_until localTime resolution (contact/org runtime tz).
//     • contactId        — the run's contact; populates place_call / send_wa actions.
//
//   runStatus contract encoded here:
//     • wait / wait_until → 'waiting' (armed timer: wakeAt set).
//     • call re-entry / branch (pure routing) → 'running' + wakeAt=null (chain to next tick).
//     • tool whose `then` is `end` → 'completed'.
import { describe, expect, it } from "bun:test";
import { interpret } from "../src/workflow/interpret";
import { WorkflowDefinitionSchema } from "../src/workflow/schema";

/** Recursively freeze inputs so an impure interpreter that MUTATES its args is caught
 *  (strict-mode assignment to a frozen object throws). Pure interpret never mutates. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const WAKE: { type: "wake" } = { type: "wake" };

// A full sequence: call → wait PT2H → whatsapp → wait_until 11:00 → call → tool → end.
const FULL_DEF = {
  entry: "call_1",
  steps: {
    call_1: {
      kind: "call",
      agent: "qualifier",
      on: {
        completed: "wait_1",
        no_answer: "wait_1",
        busy: "wait_1",
        failed: "wait_1",
      },
    },
    wait_1: { kind: "wait", for: "PT2H", then: "wa_1" },
    wa_1: { kind: "whatsapp", template: "followup_1", then: "until_1" },
    until_1: { kind: "wait_until", localTime: "11:00", then: "call_2" },
    call_2: {
      kind: "call",
      agent: "qualifier",
      on: { completed: "book", no_answer: "end" },
    },
    book: {
      kind: "tool",
      tool: "book_appointment",
      outcome: "site_visit_booked",
      args: {},
      then: "end",
    },
    end: { kind: "end" },
  },
};

describe("workflow definition schema (docs/tech-stack.md T26.2)", () => {
  it("refuses a booking step that names no outcome, or one that isn't a word, and takes any other tool step without one", () => {
    const withBook = (book: Record<string, unknown>) => ({
      entry: "book",
      steps: {
        book: { kind: "tool", then: "end", ...book },
        end: { kind: "end" },
      },
    });
    for (const bad of [
      { tool: "book_appointment" },
      { tool: "book_appointment", outcome: "Meeting Booked" },
    ])
      expect(WorkflowDefinitionSchema.safeParse(withBook(bad)).success).toBe(
        false,
      );
    expect(
      WorkflowDefinitionSchema.safeParse(
        withBook({
          tool: "create_task",
          args: { kind: "callback", title: "x" },
        }),
      ).success,
    ).toBe(true);
  });

  // behaviour already on main: only an old code in its comment was reworded
  it("rejects an unknown step kind", () => {
    // The step-kind set is CLOSED; an out-of-set kind must not validate.
    const bad = { entry: "s1", steps: { s1: { kind: "teleport" } } };
    expect(WorkflowDefinitionSchema.safeParse(bad).success).toBe(false);
  });

  // behaviour already on main: only an old code in its comment was reworded
  it("accepts a valid full-sequence definition", () => {
    // call→wait PT2H→whatsapp→wait_until 11:00→call→tool book_appointment→end validates.
    expect(WorkflowDefinitionSchema.safeParse(FULL_DEF).success).toBe(true);
  });
});

describe("workflow interpreter (docs/tech-stack.md T26.2, pure)", () => {
  const NOW = new Date("2026-07-21T04:00:00.000Z"); // = 09:30 in Asia/Kolkata (UTC+5:30)

  // behaviour already on main: only an old code in its comment was reworded
  it("call step: state.lastDisposition routes via on.<disposition>, emits no action", () => {
    // Parked on a call, the folded-in outcome 'no_answer' routes to on.no_answer.
    const def = {
      entry: "call_1",
      steps: {
        call_1: {
          kind: "call",
          agent: "qualifier",
          on: {
            completed: "route",
            no_answer: "wa_1",
            busy: "wa_1",
            failed: "give_up",
          },
        },
        wa_1: { kind: "wait", for: "PT2H", then: "end" },
        route: { kind: "branch", onDisposition: { "*": "end" } },
        give_up: { kind: "end" },
        end: { kind: "end" },
      },
    };
    const state = { currentStep: "call_1", lastDisposition: "no_answer" };
    const t = interpret(def, state, WAKE, NOW);
    expect(t.nextStep).toBe("wa_1"); // = on.no_answer
    expect(t.actions).toEqual([]); // routing emits no side effect
    expect(t.runStatus).toBe("running"); // routed; chain to next tick
    expect(t.wakeAt).toBeNull(); // routing arms no timer
  });

  // behaviour already on main: only an old code in its comment was reworded
  it("wait step: for PT2H arms wakeAt = now + 2h, waiting, no actions", () => {
    // A wait arms its timer from the fixed now.
    const def = {
      entry: "w",
      steps: {
        w: { kind: "wait", for: "PT2H", then: "nxt" },
        nxt: { kind: "end" },
      },
    };
    const t = interpret(def, { currentStep: "w" }, WAKE, NOW);
    expect(t.wakeAt).toEqual(new Date("2026-07-21T06:00:00.000Z")); // NOW + 2h
    expect(t.runStatus).toBe("waiting");
    expect(t.actions).toEqual([]);
    expect(t.nextStep).toBe("nxt"); // resume at the wait's `then` when the timer fires
  });

  // behaviour already on main: only an old code in its comment was reworded
  it("wait_until step: localTime 11:00 (Asia/Kolkata) → next local 11:00 STRICTLY after now", () => {
    // 11:00 IST = 05:30 UTC. Explicit tz + absolute `now` keep this machine-tz-independent.
    const def = {
      entry: "u",
      steps: {
        u: { kind: "wait_until", localTime: "11:00", then: "nxt" },
        nxt: { kind: "end" },
      },
    };
    const at = (nowIso: string) =>
      interpret(
        def,
        { currentStep: "u", timezone: "Asia/Kolkata" },
        WAKE,
        new Date(nowIso),
      );

    // 09:30 IST (before 11:00) → same day 11:00 IST
    expect(at("2026-07-21T04:00:00.000Z").wakeAt).toEqual(
      new Date("2026-07-21T05:30:00.000Z"),
    );
    // exactly 11:00 IST → STRICTLY after ⇒ next day
    expect(at("2026-07-21T05:30:00.000Z").wakeAt).toEqual(
      new Date("2026-07-22T05:30:00.000Z"),
    );
    // 11:30 IST (after 11:00) → next day 11:00 IST
    expect(at("2026-07-21T06:00:00.000Z").wakeAt).toEqual(
      new Date("2026-07-22T05:30:00.000Z"),
    );
    expect(at("2026-07-21T04:00:00.000Z").runStatus).toBe("waiting");
  });

  // behaviour already on main: only an old code in its comment was reworded
  it("whatsapp step: emits send_wa AND arms the following wait in the same transition", () => {
    // In a single tick — the send goes out and the next timer is armed together.
    const def = {
      entry: "wa",
      steps: {
        wa: { kind: "whatsapp", template: "followup_1", then: "wait_1" },
        wait_1: { kind: "wait", for: "PT2H", then: "call_2" },
        call_2: { kind: "call", agent: "qualifier", on: { completed: "end" } },
        end: { kind: "end" },
      },
    };
    const state = {
      currentStep: "wa",
      contactId: "contact-123",
      vars: { first_name: "Aarav" },
    };
    const t = interpret(def, state, WAKE, NOW);

    expect(t.actions).toHaveLength(1);
    const wa = t.actions[0];
    expect(wa?.kind).toBe("send_wa");
    if (wa?.kind === "send_wa") {
      expect(wa.contactId).toBe("contact-123");
      expect(wa.template).toBe("followup_1");
      expect(typeof wa.vars).toBe("object");
    }
    expect(t.runStatus).toBe("waiting"); // parked on the armed follow-up timer
    expect(t.wakeAt).toEqual(new Date("2026-07-21T06:00:00.000Z")); // wait_1 armed = NOW + 2h
    expect(t.nextStep).toBe("call_2"); // advanced past BOTH the whatsapp and its wait
  });

  // behaviour already on main: only an old code in its comment was reworded
  it("branch step: onDisposition picks the matching arm; unmatched falls through to '*'", () => {
    // A branch routes on the disposition the call folded in, falling back to its "*" arm.
    const def = {
      entry: "route",
      steps: {
        route: {
          kind: "branch",
          onDisposition: {
            qualified: "task_human",
            callback: "task_human",
            dnc: "end",
            "*": "give_up",
          },
        },
        task_human: {
          kind: "tool",
          tool: "create_task",
          args: { kind: "callback" },
          then: "end",
        },
        give_up: {
          kind: "tool",
          tool: "create_task",
          args: { kind: "review" },
          then: "end",
        },
        end: { kind: "end" },
      },
    };

    const matched = interpret(
      def,
      { currentStep: "route", lastDisposition: "qualified" },
      WAKE,
      NOW,
    );
    expect(matched.nextStep).toBe("task_human");
    expect(matched.actions).toEqual([]);
    expect(matched.runStatus).toBe("running");

    const fell = interpret(
      def,
      { currentStep: "route", lastDisposition: "totally_unmapped" },
      WAKE,
      NOW,
    );
    expect(fell.nextStep).toBe("give_up"); // the '*' arm
  });

  it("tool step book_appointment (terminal): a write_outcome action under the outcome the step names, nextStep=end, completed", () => {
    // book_appointment records the booked appointment as an OUTCOME, named by the step's own `outcome` (a row of the
    // company's sequence), so the interpreter emits a write_outcome action of that name.
    const def = {
      entry: "book",
      steps: {
        book: {
          kind: "tool",
          tool: "book_appointment",
          outcome: "meeting_booked",
          args: {},
          then: "end",
        },
        end: { kind: "end" },
      },
    };
    const t = interpret(
      def,
      { currentStep: "book", contactId: "contact-123" },
      WAKE,
      NOW,
    );
    expect(t.actions).toHaveLength(1);
    expect(t.actions[0]).toEqual({
      kind: "write_outcome",
      outcome: { kind: "meeting_booked", contactId: "contact-123" },
    });
    expect(t.nextStep).toBe("end");
    expect(t.runStatus).toBe("completed");
    expect(t.wakeAt).toBeNull();
  });

  // behaviour already on main: only an old code in its comment was reworded
  it("is pure: identical inputs → deep-equal Transitions, no db handle in the signature", () => {
    // Pure: the same inputs give deep-equal results, and frozen inputs are never mutated.
    const def = deepFreeze({
      entry: "w",
      steps: {
        w: { kind: "wait", for: "PT2H", then: "nxt" },
        nxt: { kind: "end" },
      },
    });
    const state = deepFreeze({ currentStep: "w" });
    const event = deepFreeze({ type: "wake" as const });
    const now = new Date("2026-07-21T04:00:00.000Z");

    const t1 = interpret(def, state, event, now);
    const t2 = interpret(def, state, event, now);

    expect(t1).toEqual(t2); // determinism — the observable proxy for "no hidden state / no I/O"
    expect(interpret.length).toBe(4); // signature is exactly (def, state, event, now) — no db handle
    // …and it actually computed the transition (non-vacuous):
    expect(t1.wakeAt).toEqual(new Date("2026-07-21T06:00:00.000Z"));
    expect(t1.runStatus).toBe("waiting");
    expect(t1.actions).toEqual([]);
  });
});
