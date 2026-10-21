// biome-ignore-all lint/suspicious/noThenProperty: `then` is a workflow step FIELD (data, not a
// thenable) in the definition JSON (docs/tech-stack.md T26.2), e.g. { kind:"tool", tool:"…", then:"end" }.
// Inline ACTION PAYLOADS are the interpreter's, not the definition's `args`. Env-free and PURE (interpret does zero
// I/O, fixed `now`).
//
// Why: the scheduler (applyInlineAction in services/worker/src/scheduler.ts) writes these payloads straight into SQL
// parameters. outcomes.kind is `text not null` with no check constraint (migration 005_outcomes.sql), so a name an
// `args` key slipped in would insert silently; tasks.kind and title are `not null` with a fixed kind set (migration
// 006_harness.sql), so an empty task would fail on every tick. And outcomes.contact_id is a link Postgres checks with
// row security bypassed, so an args-supplied id of ANOTHER company's lead would land an outcome attributing revenue to
// it. A booking step's outcome is named by the step's own `outcome` field, a row of the company's sequence.
//
// PINNED here:
//   1. interpreter-owned fields are AUTHORITATIVE — definition `args` can never repoint an
//      outcome at another tenant's contact, never rename the outcome the step names, and never
//      change the Action kind itself;
//   2. author-owned CONTENT still flows (a create_task step's kind/title reach the action) —
//      the positive control, so "ignore args entirely" is not a passing fix;
//   3. the interpreter never emits an inline payload the DB would reject: for a payload that
//      cannot be made valid, EITHER interpret throws loudly (zod at the boundary) OR the payload
//      it emits is DB-valid (task kind in the CHECK set + a non-empty title).
//
// NOT PINNED (deliberately): WHERE the schemas live, their names, whether extra args are preserved as task `payload`
//   / outcome `attributes` (the scheduler destructures the remainder into jsonb today), and the exact error text.
//   This pins validation at the INTERPRETER, the producer of the action, not in applyInlineAction.
import { describe, expect, it } from "bun:test";
import { interpret } from "../src/workflow/interpret";
import type { WorkflowDefinition } from "../src/workflow/schema";

const WAKE: { type: "wake" } = { type: "wake" };
const NOW = new Date("2026-08-01T04:00:00.000Z");

const OWN_CONTACT = "11111111-1111-4111-8111-111111111111";
/** A contact id belonging to ANOTHER tenant — the FK would accept it, RLS never sees it. */
const FOREIGN_CONTACT = "22222222-2222-4222-8222-222222222222";

/** tasks.kind check constraint (the tasks table, migration 006_harness.sql). */
const TASK_KINDS = ["approval", "callback", "review", "handoff", "manual"];

function bookDef(args: Record<string, unknown>): WorkflowDefinition {
  return {
    entry: "book",
    steps: {
      book: {
        kind: "tool",
        tool: "book_appointment",
        outcome: "meeting_booked",
        args,
        then: "end",
      },
      end: { kind: "end" },
    },
  };
}

function toolDef(
  tool: string,
  args?: Record<string, unknown>,
): WorkflowDefinition {
  const step: Record<string, unknown> = { kind: "tool", tool, then: "end" };
  if (args !== undefined) step.args = args;
  return {
    entry: "t",
    steps: {
      t: step as WorkflowDefinition["steps"][string],
      end: { kind: "end" },
    },
  };
}

/** Run interpret and report EITHER the loud rejection OR the single action it emitted. */
function emitted(def: WorkflowDefinition, contactId = OWN_CONTACT) {
  try {
    const t = interpret(def, { contactId }, WAKE, NOW);
    return { threw: false as const, action: t.actions[0] };
  } catch (err) {
    return {
      threw: true as const,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("inline action payloads are interpreter-owned", () => {
  it("cross-tenant denial: definition args cannot repoint a booked outcome at another org's contact", () => {
    // The whole point of the FK-bypasses-RLS edge: org A's definition naming org B's contact id.
    const r = emitted(bookDef({ contactId: FOREIGN_CONTACT }));
    expect(r.threw).toBe(false); // a well-formed book_appointment step is legal — it must still emit
    const action = r.threw ? undefined : r.action;
    expect(action?.kind).toBe("write_outcome");
    const outcome =
      action?.kind === "write_outcome"
        ? (action.outcome as Record<string, unknown>)
        : {};
    // the foreign id NEVER becomes the attribution target…
    const attributedTo = outcome.contactId as string | undefined;
    expect(attributedTo).not.toBe(FOREIGN_CONTACT);
    // …the run's own contact does (or the field is absent and scheduler.ts falls back to
    // run.contact_id — both are correct; an args-supplied contact is not).
    expect([OWN_CONTACT, undefined]).toContain(attributedTo);
  });

  it("definition args cannot rename the outcome the booking step names", () => {
    // outcomes.kind has NO check constraint, so an overridden kind would insert silently and
    // corrupt the moat table's attribution taxonomy.
    const r = emitted(
      bookDef({ kind: "converted", contactId: FOREIGN_CONTACT }),
    );
    const action = r.threw ? undefined : r.action;
    const outcome =
      action?.kind === "write_outcome"
        ? (action.outcome as Record<string, unknown>)
        : {};
    expect(outcome.kind).toBe("meeting_booked"); // the step's own outcome, never an args key
  });

  it("definition args cannot change the ACTION kind (the closed side-effect set)", () => {
    // args.kind on a create_task step is the TASK kind (author-owned); the ACTION kind is not.
    const r = emitted(
      toolDef("notify_owner", {
        kind: "callback",
        title: "Ring Asha back",
        action: "place_call",
      }),
    );
    const action = r.threw ? undefined : r.action;
    expect(action?.kind).toBe("create_task");
  });

  // behaviour already on main: only its comment's line-number citation became the test it names
  it("author-owned task CONTENT still reaches the action (positive control)", () => {
    // "ignore args entirely" must NOT be a passing fix — a tool step's task kind/title are the
    // definition's to choose (services/worker/test/scheduler.test.ts, its "tick is atomic" test, relies on exactly this).
    const r = emitted(
      toolDef("notify_owner", { kind: "callback", title: "Ring Asha back" }),
    );
    expect(r.threw).toBe(false);
    const action = r.threw ? undefined : r.action;
    expect(action?.kind).toBe("create_task");
    const task =
      action?.kind === "create_task"
        ? (action.task as Record<string, unknown>)
        : {};
    expect(task.kind).toBe("callback");
    expect(task.title).toBe("Ring Asha back");
  });

  // behaviour already on main: only its comments' old codes and line-number citations were reworded
  it("never emits an inline payload the DB would reject — it rejects loudly instead", () => {
    // Each case is a definition that PASSES WorkflowDefinitionSchema (its tool step: `tool` is a free string, `args`
    // optional) and would produce SQL the tasks table's not-null and kind checks refuse (migration 006_harness.sql).
    const cases: { label: string; def: WorkflowDefinition }[] = [
      // the poison run exactly: no args at all -> task {} -> 23502 on kind AND title
      { label: "no args", def: toolDef("notify_owner") },
      // wrong types: kind/title are text not null
      {
        label: "wrong-typed args",
        def: toolDef("notify_owner", { kind: 42, title: { deep: true } }),
      },
      // a task kind outside the CHECK set -> 23514 every tick
      {
        label: "out-of-set task kind",
        def: toolDef("notify_owner", { kind: "notify", title: "x" }),
      },
      // title present but empty is still not a human-readable HITL row
      {
        label: "empty title",
        def: toolDef("notify_owner", { kind: "callback", title: "" }),
      },
    ];

    const verdicts = cases.map(({ label, def }) => {
      const r = emitted(def);
      if (r.threw) return { label, ok: true }; // loud rejection at the boundary
      const action = r.action;
      const task =
        action?.kind === "create_task"
          ? (action.task as Record<string, unknown>)
          : {};
      const ok =
        TASK_KINDS.includes(String(task.kind)) &&
        typeof task.title === "string" &&
        task.title.length > 0;
      return { label, ok, emitted: task };
    });

    expect(verdicts.map((v) => ({ label: v.label, ok: v.ok }))).toEqual(
      cases.map(({ label }) => ({ label, ok: true })),
    );
  });
});
