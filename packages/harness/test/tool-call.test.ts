// One tool call the model asks for (src/tool-call.ts): a tool the agent may not use, or arguments that don't fit the
// tool's schema, never reach the tool; a valid call runs the tool and says what came of it. The database is a stand-in
// that takes every write: what is checked here is what the call returns and whether the tool ran.
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../src/registry";
import { runToolCall } from "../src/tool-call";
import type { OrgCtx, Tool } from "../src/types";

const ctx: OrgCtx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  db: { query: async () => ({ rows: [], rowCount: 1 }) },
};
const CONVO = "00000000-0000-4000-8000-000000000002";

function setup() {
  const ran: unknown[] = [];
  const note: Tool<{ text: string }> = {
    name: "note",
    description: "Write a note.",
    schema: z.object({ text: z.string().min(1) }).strict(),
    autonomy: "auto",
    execute: async (_ctx, args) => {
      ran.push(args);
      return { ok: true, data: null };
    },
  };
  const registry = new ToolRegistry();
  registry.register(note);
  return { ran, deps: { registry, toolsAllowed: ["note"], pipeline: [] } };
}

describe("one tool call", () => {
  it("refuses a tool the agent may not use, without running anything", async () => {
    const { ran, deps } = setup();
    const record = await runToolCall(deps, ctx, CONVO, 1, {
      name: "send_money",
      args: {},
    });
    expect(record).toEqual({
      name: "send_money",
      result: { ok: false, error: "unknown_or_unallowed_tool" },
    });
    expect(ran).toHaveLength(0);
  });

  it("refuses arguments that don't fit the tool's schema, without running the tool", async () => {
    const { ran, deps } = setup();
    const record = await runToolCall(deps, ctx, CONVO, 1, {
      name: "note",
      args: { text: "" },
    });
    expect(record).toEqual({
      name: "note",
      result: { ok: false, error: "invalid_args" },
    });
    expect(ran).toHaveLength(0);
  });

  it("runs a valid call and records its arguments and result", async () => {
    const { ran, deps } = setup();
    const record = await runToolCall(deps, ctx, CONVO, 1, {
      name: "note",
      args: { text: "call back at 5" },
    });
    expect(record).toEqual({
      name: "note",
      args: { text: "call back at 5" },
      result: { ok: true, data: null },
    });
    expect(ran).toEqual([{ text: "call back at 5" }]);
  });
});
