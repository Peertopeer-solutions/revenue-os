// Task T8 (task-48) — worker WIRING, env-free UNIT half. Criteria 1 (env ANTHROPIC_API_KEY
// optional) + 2 (Claude provider gating). These run WITHOUT a DB (the worktree gate): env.ts
// imports only zod, and jobs.ts's db pool is lazy (createPool = new pg.Pool, which connects on the
// first query, never at import) — so importing either is side-effect-free once the module-scope
// env parse has values. We fill DATABASE_URL/SUPABASE_URL with dummies ONLY when absent (||=), so
// CI's real values — and the sibling integration suites that read env.DATABASE_URL through the
// cached env singleton — are never clobbered.
//
// The symbols under test do NOT exist yet (T8 must EXPORT EnvSchema and ADD makeProvider). We
// DYNAMIC-import so a missing export reads back as `undefined` — an ASSERTION failure — instead of
// an ESM link error (the wrong reason to be red). NEVER a real key here: createAnthropicProvider is
// pure construction (no fetch until .complete(), which we never call), so a dummy string is enough.
import { describe, expect, it } from "bun:test";

// Satisfy env.ts's module-scope EnvSchema.parse without a real environment. ||= never overrides a
// value CI already set, so the import-frozen env singleton stays real for sibling suites.
process.env.DATABASE_URL ||=
  "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres";
process.env.SUPABASE_URL ||= "http://localhost:54321";

const GOOD_DB = "postgresql://app_service:x@127.0.0.1:54322/postgres";
const GOOD_SUPABASE = "http://localhost:54321";
const CORS = ["http://localhost:5173"];
const DUMMY_KEY = "sk-ant-test-dummy"; // NOT a real key — construction never touches the network

describe("T8 env: ANTHROPIC_API_KEY optional; other vars stay required [criterion 1]", () => {
  it("parses with the key (value kept), without it (undefined), and refuses half-config", async () => {
    const { EnvSchema } = await import("../src/env");
    expect(EnvSchema).toBeDefined(); // T8 must EXPORT the schema to test it directly

    const withKey = EnvSchema.parse({
      DATABASE_URL: GOOD_DB,
      SUPABASE_URL: GOOD_SUPABASE,
      ANTHROPIC_API_KEY: DUMMY_KEY,
    });
    expect(withKey.ANTHROPIC_API_KEY).toBe(DUMMY_KEY); // present -> carried through, not stripped

    const noKey = EnvSchema.parse({
      DATABASE_URL: GOOD_DB,
      SUPABASE_URL: GOOD_SUPABASE,
    });
    expect(noKey.ANTHROPIC_API_KEY).toBeUndefined(); // absent -> optional, still parses OK

    // half-configured still refuses: DATABASE_URL stays required even with the key present.
    const missingDb = EnvSchema.safeParse({
      SUPABASE_URL: GOOD_SUPABASE,
      ANTHROPIC_API_KEY: DUMMY_KEY,
    });
    expect(missingDb.success).toBe(false);
  });
});

describe("T8 LLM: the Claude provider is wired IFF ANTHROPIC_API_KEY is present [criterion 2]", () => {
  it("present key -> a real LlmProvider, constructed WITHOUT any network call", async () => {
    const { makeProvider } = await import("../src/jobs");
    expect(makeProvider).toBeDefined(); // T8 must add the pure provider-wiring fn

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.reject(new Error("no network in a unit test"));
    }) as typeof fetch;
    try {
      const provider = makeProvider({
        DATABASE_URL: GOOD_DB,
        SUPABASE_URL: GOOD_SUPABASE,
        CORS_ORIGINS: CORS,
        ANTHROPIC_API_KEY: DUMMY_KEY,
      });
      expect(provider).toBeTruthy(); // a provider is produced when the key is present
      expect(typeof provider.complete).toBe("function"); // it implements LlmProvider
      expect(fetchCalls).toBe(0); // pure construction — no fetch until .complete(), never called
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("absent key -> NO provider (null) and NO throw (boot-without-key stays green)", async () => {
    const { makeProvider } = await import("../src/jobs");
    expect(makeProvider).toBeDefined();

    const noKeyEnv = {
      DATABASE_URL: GOOD_DB,
      SUPABASE_URL: GOOD_SUPABASE,
      CORS_ORIGINS: CORS,
      ANTHROPIC_API_KEY: undefined,
    };
    expect(() => makeProvider(noKeyEnv)).not.toThrow(); // boot must not crash without a key
    expect(makeProvider(noKeyEnv)).toBeNull(); // and no Claude provider is produced
  });
});

describe("the worker's Claude provider names no model of its own", () => {
  it("sends the model each turn names, from its role version, and refuses one off the platform's list", async () => {
    const { makeProvider } = await import("../src/jobs");
    const originalFetch = globalThis.fetch;
    const sent: unknown[] = [];
    globalThis.fetch = ((_url: unknown, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}").model);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;
    try {
      const provider = makeProvider({
        DATABASE_URL: GOOD_DB,
        SUPABASE_URL: GOOD_SUPABASE,
        CORS_ORIGINS: CORS,
        ANTHROPIC_API_KEY: DUMMY_KEY,
      });
      const ask = (model: string) =>
        provider?.complete({
          model,
          system: "s",
          messages: [{ role: "contact", content: "hi" }],
        });
      await ask("anthropic:claude-haiku-5-5");
      await ask("anthropic:claude-sonnet-5-5");
      expect(sent).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
      await expect(ask("claude-opus-4-8")).rejects.toThrow(
        "platform's model list",
      );
      expect(sent).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
