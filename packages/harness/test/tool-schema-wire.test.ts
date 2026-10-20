// task-57 RED — H1: tool schemas are never converted to JSON Schema.
//
// GROUND TRUTH (reproduced with the repo's own zod 4.4.3 + buildCatalog, not assumed):
//   registry.ts:29 sets `inputSchema: t.schema` — the LIVE ZodType instance. anthropic.ts:44-52
//   ships it verbatim as `input_schema` and JSON.stringify at :62 is the only transform. The
//   object that reaches the wire has top-level keys ["def","type"] and NO `properties` at all,
//   for all three production tools. `z.toJSONSchema()` exists in 4.4.3 and is called nowhere.
//
// CONTRACT PINNED (behaviour at the boundary, not the mechanism): whatever a provider is handed
// must, AFTER a JSON round-trip, be a real JSON Schema — type:"object", a `properties` map with
// exactly the declared arg names, `required` listing exactly the non-optional args, and zero zod
// internals. The round-trip is the point: JSON.stringify is what actually goes on the wire, so
// asserting on the live object would let a zod instance masquerade as a schema.
//
// WHERE the conversion lives is the worker's call (registry.specs, a helper in loop.ts, or the
// adapter) — every placement at-or-before `provider.complete()` passes these tests unchanged.
//
// ENV-FREE: no DB, no network, no key. `fetch` is stubbed and restored; the catalog's send port
// is a no-op fake. TENANCY: this task adds no table, so the cross-tenant-denial non-negotiable
// has no target here — flagged in the report.
import { afterEach, describe, expect, it } from "bun:test";
import { createAnthropicProvider } from "../src/llm";
import { runTurn } from "../src/loop";
import { buildCatalog } from "../src/tools";
import type { LlmProvider, OrgCtx, OrgScopedDb, ToolSpec } from "../src/types";

const ORG = "org-1";
const CONVERSATION = "conv-1";
const ALL_TOOLS = ["send_confirmation", "book_appointment", "update_contact"];
const noopSend = async () => ({ ok: true });

/** The declared args of each production tool, and which of them are non-optional. */
const DECLARED: Record<string, { props: string[]; required: string[] }> = {
  book_appointment: {
    props: ["contactId", "startsAt", "endsAt", "timezone"],
    required: ["contactId", "startsAt", "endsAt", "timezone"],
  },
  update_contact: {
    props: ["contactId", "firstName", "lastName"],
    required: ["contactId"],
  },
  send_confirmation: {
    props: ["contactId", "channel", "body"],
    required: ["contactId", "channel", "body"],
  },
};

/** Every key name appearing anywhere in the round-tripped value — the zod-internals detector. */
function deepKeys(value: unknown, seen: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) deepKeys(v, seen);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      seen.push(k);
      deepKeys(v, seen);
    }
  }
  return seen;
}

/** JSON-Schema-shaped: a property value must itself describe a type, not be an opaque blob. */
const describesAType = (v: unknown): boolean =>
  Boolean(v) &&
  typeof v === "object" &&
  ["type", "enum", "anyOf", "oneOf", "allOf", "$ref", "const"].some(
    (k) => k in (v as Record<string, unknown>),
  );

/** The whole H1 contract, applied to ONE round-tripped input schema. */
function expectJsonSchema(name: string, live: unknown) {
  const spec = DECLARED[name];
  if (!spec) throw new Error(`no declared args recorded for tool '${name}'`);

  // The round trip IS the contract: this is the value the provider serialises onto the wire.
  const wire = JSON.parse(JSON.stringify(live)) as Record<string, unknown>;

  expect({ tool: name, type: wire.type }).toEqual({
    tool: name,
    type: "object",
  });

  const properties = wire.properties as Record<string, unknown> | undefined;
  expect({ tool: name, hasProperties: typeof properties }).toEqual({
    tool: name,
    hasProperties: "object",
  });
  expect(Object.keys(properties ?? {}).sort()).toEqual([...spec.props].sort());
  for (const [key, value] of Object.entries(properties ?? {})) {
    expect({
      tool: name,
      prop: key,
      schemaShaped: describesAType(value),
    }).toEqual({ tool: name, prop: key, schemaShaped: true });
  }

  const required = (wire.required ?? []) as string[];
  expect([...required].sort()).toEqual([...spec.required].sort());

  // No zod internals may survive the round trip — `{def, type}` is a ZodType, not a schema.
  const internals = deepKeys(wire).filter((k) =>
    ["def", "_def", "_zod", "shape", "~standard"].includes(k),
  );
  expect({ tool: name, zodInternals: internals }).toEqual({
    tool: name,
    zodInternals: [],
  });
}

/** Write-only fake db: the text-only turn never reads a row it cares about. */
const stubDb: OrgScopedDb = {
  query: async (text: string) => {
    if (/from conversations/i.test(text))
      return { rows: [{ id: CONVERSATION }], rowCount: 1 }; // the conversation addMessage locks
    if (/coalesce\(max\(seq\)/i.test(text))
      return { rows: [{ seq: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
};
const stubCtx: OrgCtx = { orgId: ORG, db: stubDb };

/** Records the tool specs runTurn hands a provider; closes the turn with plain text. */
function recordingProvider(): { provider: LlmProvider; seen: ToolSpec[][] } {
  const seen: ToolSpec[][] = [];
  return {
    seen,
    provider: {
      complete: async (req) => {
        seen.push(req.tools ?? []);
        return { text: "done", usage: { in: 1, out: 1 } };
      },
    },
  };
}

describe("task-57 H1 — the tool specs a provider is handed are JSON Schema, not zod", () => {
  it("runTurn hands provider.complete() a JSON-Schema input schema for every production tool", async () => {
    const { provider, seen } = recordingProvider();
    await runTurn(
      {
        provider,
        registry: buildCatalog({ send: noopSend }),
        toolsAllowed: ALL_TOOLS,
        systemPrompt: "t",
      },
      stubCtx,
      CONVERSATION,
    );

    expect(seen).toHaveLength(1);
    const specs = seen[0] ?? [];
    expect(specs.map((s) => s.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const spec of specs) expectJsonSchema(spec.name, spec.inputSchema);
  });

  it("the live zod schema stays the runtime seatbelt: bad args are still rejected after conversion", async () => {
    // The obvious wrong fix is to overwrite Tool.schema with the converted JSON Schema. That
    // would silently kill the T11 hallucination seatbelt (loop.ts:138 safeParse), so pin it here
    // in an env-free test — the DB-backed sibling (loop.test.ts) only runs in CI.
    const registry = buildCatalog({ send: noopSend });
    const tool = registry.get("send_confirmation", ALL_TOOLS);
    expect(tool).toBeDefined();
    expect(
      tool?.schema.safeParse({ contactId: "nope", channel: "carrier-pigeon" })
        .success,
    ).toBe(false);
    expect(
      tool?.schema.safeParse({
        contactId: "11111111-1111-4111-8111-111111111111",
        channel: "whatsapp",
        body: "See you at 5pm.",
      }).success,
    ).toBe(true);
  });
});

// ---- end-to-end: what actually leaves the process on the HTTP wire. ---------------------------
let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function captureBody(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body !== "string")
      throw new Error("adapter must send a JSON string body");
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as unknown as typeof globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
  return { bodies };
}

describe("task-57 H1 end-to-end — the Anthropic request body carries real input_schema", () => {
  it("tools[].input_schema on the wire is JSON Schema for every production tool", async () => {
    const { bodies } = captureBody();
    const specs = buildCatalog({ send: noopSend }).specs(ALL_TOOLS);
    await createAnthropicProvider({
      apiKey: "test-key",
      model: "claude-test",
    }).complete({
      system: "s",
      messages: [{ role: "contact", content: "hi" }],
      tools: specs,
    });

    expect(bodies).toHaveLength(1);
    const tools = (bodies[0]?.tools ?? []) as {
      name: string;
      input_schema: unknown;
    }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const t of tools) expectJsonSchema(t.name, t.input_schema);
  });
});
