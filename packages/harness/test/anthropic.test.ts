// The Anthropic (Claude) model adapter behind LlmProvider, which calls the API with raw `fetch` (docs/tech-stack.md
// T19: "raw fetch, no SDK"; that no package uses the SDK is a guard, scripts/guards/anthropic-sdk.sh). Every test is ENV-FREE,
// NETWORK-FREE and KEY-FREE:
//   * globalThis.fetch is replaced (installFetch) by a fake that NEVER hits the network — it
//     returns a canned Anthropic /v1/messages JSON Response and records the call args — and is
//     restored after every test (afterEach). No real socket is ever opened.
//   * the apiKey is a dummy "test-key"; no real key, no .env, no DB. The real /v1/messages
//     round-trip is CI/live-owned, never here.

import { afterEach, describe, expect, it } from "bun:test";
import { createAnthropicProvider } from "../src/llm";
import type { Msg, ToolSpec } from "../src/types";

// ---- fetch stub: records calls, returns a canned Response, restored after each test. ----------
type Captured = { url: string; init: unknown };
let restoreFetch: (() => void) | null = null;

function installFetch(cannedBody: unknown): { calls: Captured[] } {
  const calls: Captured[] = [];
  const real = globalThis.fetch;
  const fake = (input: unknown, init?: unknown): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input);
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(cannedBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  globalThis.fetch = fake as unknown as typeof globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = real;
  };
  return { calls };
}

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

// ---- canned Anthropic Messages API response bodies. -------------------------------------------
const textBlock = (text: string) => ({ type: "text", text });
const toolUseBlock = (name: string, input: unknown, id = "toolu_x") => ({
  type: "tool_use",
  id,
  name,
  input,
});
function anthropicBody(opts: {
  content: unknown[];
  usage?: { input_tokens: number; output_tokens: number };
}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet-latest",
    content: opts.content,
    stop_reason: "end_turn",
    usage: opts.usage ?? { input_tokens: 1, output_tokens: 1 },
  };
}

// ---- helpers to read the captured request (representation-agnostic). --------------------------
function headerOf(init: unknown, name: string): string | null {
  const h = (init as { headers?: unknown } | null | undefined)?.headers;
  if (h instanceof Headers) return h.get(name);
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (k.toLowerCase() === name.toLowerCase())
        return v == null ? null : String(v);
    }
  }
  return null;
}
function jsonBodyOf(init: unknown): Record<string, unknown> {
  const b = (init as { body?: unknown }).body;
  if (typeof b !== "string")
    throw new Error("adapter must send a JSON string body");
  return JSON.parse(b) as Record<string, unknown>;
}

const KEY = "test-key";
const MODEL = "anthropic:claude-sonnet-5-5"; // the role version's model, as each call names it
const newProvider = () => createAnthropicProvider({ apiKey: KEY });
const baseReq = {
  model: MODEL,
  system: "You are a test agent.",
  messages: [] as Msg[],
};
const oneContact: Msg[] = [{ role: "contact", content: "hi" }];

describe("createAnthropicProvider — response → LlmTurn mapping", () => {
  it("maps a text-only response to LlmTurn.text, with no tool calls", async () => {
    installFetch(anthropicBody({ content: [textBlock("Hello, world.")] }));
    const turn = await newProvider().complete({
      ...baseReq,
      messages: oneContact,
    });
    expect(turn.text).toBe("Hello, world.");
    expect(turn.toolCalls ?? []).toEqual([]);
  });

  it("joins multiple text blocks into a single text field, in order", async () => {
    installFetch(
      anthropicBody({
        content: [textBlock("part-one "), textBlock("part-two")],
      }),
    );
    const turn = await newProvider().complete({
      ...baseReq,
      messages: oneContact,
    });
    expect(typeof turn.text).toBe("string");
    const text = turn.text ?? "";
    expect(text).toContain("part-one");
    expect(text).toContain("part-two");
    expect(text.indexOf("part-one")).toBeLessThan(text.indexOf("part-two"));
  });

  it("maps a tool_use block to LlmTurn.toolCalls [{ name, args }]", async () => {
    const input = { contactId: "c1", firstName: "Ada" };
    installFetch(
      anthropicBody({ content: [toolUseBlock("update_contact", input)] }),
    );
    const turn = await newProvider().complete({
      ...baseReq,
      messages: oneContact,
    });
    expect(turn.toolCalls).toEqual([{ name: "update_contact", args: input }]);
    expect(turn.text ?? "").toBe("");
  });

  it("maps multiple tool_use blocks to multiple toolCalls, in order", async () => {
    installFetch(
      anthropicBody({
        content: [
          toolUseBlock("update_contact", { contactId: "c1" }, "toolu_1"),
          toolUseBlock("send_quote", { amount: 100 }, "toolu_2"),
        ],
      }),
    );
    const turn = await newProvider().complete({
      ...baseReq,
      messages: oneContact,
    });
    expect(turn.toolCalls).toEqual([
      { name: "update_contact", args: { contactId: "c1" } },
      { name: "send_quote", args: { amount: 100 } },
    ]);
  });

  it("maps a mixed text + tool_use response to both text and toolCalls", async () => {
    const input = { contactId: "c1", amount: 100 };
    installFetch(
      anthropicBody({
        content: [
          textBlock("Let me quote that."),
          toolUseBlock("send_quote", input),
        ],
      }),
    );
    const turn = await newProvider().complete({
      ...baseReq,
      messages: oneContact,
    });
    expect(turn.text).toBe("Let me quote that.");
    expect(turn.toolCalls).toEqual([{ name: "send_quote", args: input }]);
  });

  it("maps usage.input_tokens/output_tokens to usage.in/out", async () => {
    installFetch(
      anthropicBody({
        content: [textBlock("ok")],
        usage: { input_tokens: 42, output_tokens: 13 },
      }),
    );
    const turn = await newProvider().complete({
      ...baseReq,
      messages: oneContact,
    });
    expect(turn.usage).toEqual({ in: 42, out: 13 });
  });
});

describe("createAnthropicProvider — the model is the role version's, on the platform's list", () => {
  it("sends each listed Anthropic model as its own id, whichever the call names", async () => {
    const { calls } = installFetch(
      anthropicBody({ content: [textBlock("ok")] }),
    );
    const provider = newProvider();
    for (const model of [
      "anthropic:claude-opus-5-5",
      "anthropic:claude-haiku-5-5",
    ])
      await provider.complete({ ...baseReq, model, messages: oneContact });
    expect(calls.map((c) => jsonBodyOf(c.init).model as string)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ]);
  });

  it("refuses, sending nothing, a model off the list, a bare id, a tier name or none", async () => {
    const { calls } = installFetch(
      anthropicBody({ content: [textBlock("ok")] }),
    );
    for (const model of [
      "claude-sonnet-5-5",
      "realtime-tier",
      "openai:gpt-5",
      "",
    ])
      await expect(
        newProvider().complete({ ...baseReq, model, messages: oneContact }),
      ).rejects.toThrow(
        "is not an Anthropic model on the platform's model list",
      );
    expect(calls).toHaveLength(0);
  });
});

describe("createAnthropicProvider — request shaping", () => {
  it("POSTs exactly once to https://api.anthropic.com/v1/messages with x-api-key + anthropic-version headers", async () => {
    const { calls } = installFetch(
      anthropicBody({ content: [textBlock("ok")] }),
    );
    await newProvider().complete({ ...baseReq, messages: oneContact });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as Captured;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init as { method?: string }).method).toBe("POST");
    expect(headerOf(init, "x-api-key")).toBe(KEY);
    expect(headerOf(init, "anthropic-version")).toBeTruthy();
  });

  it("sends the listed model's own id + system as top-level fields and passes max_tokens (system separate from messages)", async () => {
    const { calls } = installFetch(
      anthropicBody({ content: [textBlock("ok")] }),
    );
    await newProvider().complete({
      model: MODEL,
      system: "SYSTEM-PROMPT-MARKER",
      messages: oneContact,
      maxTokens: 512,
    });
    expect(calls).toHaveLength(1);
    const body = jsonBodyOf((calls[0] as Captured).init);
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.system).toBe("SYSTEM-PROMPT-MARKER");
    expect(body.max_tokens).toBe(512);
    // "system separate": the system prompt must NOT be smuggled into the messages array.
    expect(JSON.stringify(body.messages)).not.toContain("SYSTEM-PROMPT-MARKER");
  });

  // behaviour already on main: only the model each call now names was added to its request
  it("maps our contact/agent roles to Anthropic user/assistant messages", async () => {
    const { calls } = installFetch(
      anthropicBody({ content: [textBlock("ok")] }),
    );
    await newProvider().complete({
      model: MODEL,
      system: "s",
      messages: [
        { role: "contact", content: "from-contact" },
        { role: "agent", content: "from-agent" },
      ],
    });
    expect(calls).toHaveLength(1);
    const body = jsonBodyOf((calls[0] as Captured).init);
    const msgs = body.messages as { role: string; content: unknown }[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect(JSON.stringify(msgs[0]?.content)).toContain("from-contact");
    expect(JSON.stringify(msgs[1]?.content)).toContain("from-agent");
  });

  it("renders a ToolSpec object input schema into the Anthropic tools[].input_schema", async () => {
    const tool: ToolSpec = {
      name: "update_contact",
      description: "Update a contact's fields",
      inputSchema: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          firstName: { type: "string" },
        },
        required: ["contactId", "firstName"],
        additionalProperties: false,
      },
    };
    const { calls } = installFetch(
      anthropicBody({ content: [textBlock("ok")] }),
    );
    await newProvider().complete({
      ...baseReq,
      messages: oneContact,
      tools: [tool],
    });
    expect(calls).toHaveLength(1);
    const body = jsonBodyOf((calls[0] as Captured).init);
    const tools = body.tools as {
      name: string;
      input_schema: Record<string, unknown>;
    }[];
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("update_contact");
    expect(tools[0]?.input_schema).toMatchObject({
      type: "object",
      properties: {
        contactId: { type: "string" },
        firstName: { type: "string" },
      },
    });
    expect(tools[0]?.input_schema.required).toEqual(["contactId", "firstName"]);
  });
});
