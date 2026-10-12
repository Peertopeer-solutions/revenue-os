// The eval runner's testable library: load eval_scenarios, drive each against the real
// harness runTurn (provider + persona-player seams INJECTED), capture sends instead of delivering,
// mechanically score must_capture / expect_outcome, and persist one eval_runs row per scenario.
//
// Design decision: the runner's logic lives HERE, not in scripts/evals.ts. scripts/evals.ts stays a
// thin CLI shell (reads argv, calls runEvals, process.exit) — importing it into a test would fire
// its top-level side effects, so the tests import this module instead.
import {
  buildCatalog,
  type LlmProvider,
  type Msg,
  type OrgCtx,
  runTurn,
  type SendPort,
} from "@revenue-os/harness";
// JSONB boundaries → Zod (schemas live in packages/shared, the canonical home — never
// re-declared locally). A row that fails ANY of the three is a malformed scenario: it is
// recorded in errors[] and skipped, never thrown.
import {
  ScenarioAssertionsSchema,
  ScenarioPersonaSchema,
  ScenarioScriptSchema,
} from "@revenue-os/shared";

/** A field counts as captured only if it is present AND non-empty: null/'' do NOT count. */
const isCaptured = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "";

// ── Scenario shape (persona/script/assertions are JSONB boundaries → Zod-parsed) ──────────
export type ParsedScenario = {
  id: string;
  key: string;
  persona: { name: string; traits?: string[]; language?: string };
  script: { turns: string[] };
  assertions: {
    must_capture?: string[];
    expect_outcome?: string;
    [k: string]: unknown;
  };
};

/** A malformed row does not crash the run — it is recorded and its scenario fails. */
export type ScenarioLoadError = {
  id?: string;
  key: string | null;
  error: string;
};
export type LoadResult = {
  scenarios: ParsedScenario[];
  errors: ScenarioLoadError[];
};

// ── Persona player seam: contact turns come from HERE, never a real LLM. Returns the next
//    contact utterance, or null when the scripted conversation is over. ──────────────────
export type PersonaPlayer = (
  scenario: ParsedScenario,
  turnIndex: number,
  transcript: Msg[],
) => Promise<string | null>;

// ── Eval-mode send seam: sends are CAPTURED, never delivered. ─────────────────────────────
export type CapturedSend = { ctx: OrgCtx; msg: Parameters<SendPort>[1] };

// ── What the mechanical assertion engine observes about a finished conversation. ──────────
export type Observed = {
  captured: Record<string, unknown>;
  outcome: string | null;
};

export type AssertionKind = "must_capture" | "expect_outcome";
export type AssertionDetail = {
  kind: AssertionKind;
  name: string;
  passed: boolean;
  detail?: string;
};

export type EvalDeps = {
  provider: LlmProvider; // INJECTED — tests never wire Anthropic
  player: PersonaPlayer; // INJECTED — canned/mock, never a real LLM
  send: SendPort; // eval-mode capturing port
  agentId: string;
  workflowId?: string;
  systemPrompt: string;
  toolsAllowed: readonly string[];
};

export type ScenarioResult = {
  key: string;
  passed: boolean;
  scores: { assertions: AssertionDetail[] };
  conversationId?: string;
  evalRunId?: string;
  captured: CapturedSend[];
  error?: string;
};

export type EvalSummary = {
  results: ScenarioResult[];
  exitCode: 0 | 1;
  summary: string;
};

/** An eval-mode SendPort that records sends instead of delivering them. */
export function createCaptureSend(): {
  send: SendPort;
  captured: CapturedSend[];
} {
  const captured: CapturedSend[] = [];
  const send: SendPort = async (ctx, msg) => {
    captured.push({ ctx, msg });
    return { ok: true };
  };
  return { send, captured };
}

/** Read eval_scenarios for the org; Zod-parse each JSONB boundary; malformed rows → errors[]. */
export async function loadScenarios(
  ctx: OrgCtx,
  opts?: { scenario?: string },
): Promise<LoadResult> {
  const scenarios: ParsedScenario[] = [];
  const errors: ScenarioLoadError[] = [];
  // Scope to the org's OWN scenarios (deterministic: global org_id-null packs are out of scope
  // for a single-org eval run). RLS would also permit globals; the explicit filter keeps runs
  // reproducible regardless of what else is seeded.
  const res = opts?.scenario
    ? await ctx.db.query(
        "select id, key, persona, script, assertions from eval_scenarios where org_id = $1 and key = $2 order by key",
        [ctx.orgId, opts.scenario],
      )
    : await ctx.db.query(
        "select id, key, persona, script, assertions from eval_scenarios where org_id = $1 order by key",
        [ctx.orgId],
      );

  for (const row of res.rows) {
    const key = typeof row.key === "string" ? row.key : null;
    const persona = ScenarioPersonaSchema.safeParse(row.persona);
    const script = ScenarioScriptSchema.safeParse(row.script);
    const assertions = ScenarioAssertionsSchema.safeParse(row.assertions);
    if (!persona.success || !script.success || !assertions.success) {
      const why = [
        persona.success ? null : "persona",
        script.success ? null : "script",
        assertions.success ? null : "assertions",
      ].filter(Boolean);
      errors.push({
        id: typeof row.id === "string" ? row.id : undefined,
        key,
        error: `malformed jsonb: ${why.join(", ")}`,
      });
      continue;
    }
    scenarios.push({
      id: row.id as string,
      key: key as string,
      persona: persona.data,
      script: script.data,
      assertions: assertions.data,
    });
  }
  return { scenarios, errors };
}

/** Mechanical, no LLM judging: must_capture + expect_outcome checked against Observed. */
export function evaluateAssertions(
  assertions: ParsedScenario["assertions"],
  observed: Observed,
): AssertionDetail[] {
  const details: AssertionDetail[] = [];
  const mustCapture = Array.isArray(assertions.must_capture)
    ? assertions.must_capture
    : [];
  for (const field of mustCapture) {
    const passed = isCaptured(observed.captured[field]);
    details.push({
      kind: "must_capture",
      name: field,
      passed,
      detail: passed ? undefined : "field not captured on the contact row",
    });
  }
  if (typeof assertions.expect_outcome === "string") {
    const expected = assertions.expect_outcome;
    const passed = observed.outcome === expected;
    details.push({
      kind: "expect_outcome",
      name: expected,
      passed,
      detail: passed
        ? undefined
        : `expected outcome ${expected}, got ${observed.outcome ?? "none"}`,
    });
  }
  return details;
}

/** The org's contact (persona stand-in). Tests seed exactly one; create one if none exists. */
async function resolveContactId(
  ctx: OrgCtx,
  personaName: string,
): Promise<string> {
  const existing = await ctx.db.query(
    "select id from contacts where org_id = $1 order by created_at limit 1",
    [ctx.orgId],
  );
  const id = existing.rows[0]?.id;
  if (typeof id === "string") return id;
  const created = await ctx.db.query(
    "insert into contacts (org_id, first_name) values ($1, $2) returning id",
    [ctx.orgId, personaName],
  );
  return created.rows[0]?.id as string;
}

/** Persist a scripted contact utterance as the next transcript row. */
async function appendContactMessage(
  ctx: OrgCtx,
  conversationId: string,
  content: string,
): Promise<void> {
  const seqRes = await ctx.db.query(
    "select coalesce(max(seq), 0) + 1 as seq from messages where org_id = $1 and conversation_id = $2",
    [ctx.orgId, conversationId],
  );
  const seq = Number(seqRes.rows[0]?.seq ?? 1);
  await ctx.db.query(
    `insert into messages (org_id, conversation_id, seq, role, content)
     values ($1, $2, $3, 'contact', $4)`,
    [ctx.orgId, conversationId, seq, content],
  );
}

/** Ground truth: must_capture fields are read BACK from the contact ROW (snake_case columns),
 *  not echoed from tool-call args; the outcome is the append-only outcomes row for this run. */
async function observe(
  ctx: OrgCtx,
  conversationId: string,
  contactId: string,
  mustCapture: string[],
): Promise<Observed> {
  const captured: Record<string, unknown> = {};
  if (mustCapture.length > 0) {
    const row =
      (
        await ctx.db.query(
          "select * from contacts where org_id = $1 and id = $2",
          [ctx.orgId, contactId],
        )
      ).rows[0] ?? {};
    for (const field of mustCapture) captured[field] = row[field];
  }
  const oc = await ctx.db.query(
    "select kind from outcomes where org_id = $1 and conversation_id = $2 order by created_at desc limit 1",
    [ctx.orgId, conversationId],
  );
  const outcome =
    typeof oc.rows[0]?.kind === "string" ? (oc.rows[0].kind as string) : null;
  return { captured, outcome };
}

/** One eval_runs row per scenario, keyed to a PERSISTED eval_scenarios row (FK). A synthetic
 *  scenario absent from the table (unit-test fixture) yields no row — nothing to reference. */
async function persistRun(
  ctx: OrgCtx,
  deps: EvalDeps,
  scenario: ParsedScenario,
  passed: boolean,
  details: AssertionDetail[],
  conversationId: string,
): Promise<string | undefined> {
  const scn = await ctx.db.query(
    "select id from eval_scenarios where org_id = $1 and key = $2 limit 1",
    [ctx.orgId, scenario.key],
  );
  const scenarioId = scn.rows[0]?.id;
  if (typeof scenarioId !== "string") return undefined;
  const run = await ctx.db.query(
    `insert into eval_runs (org_id, scenario_id, agent_id, workflow_id, passed, scores, transcript_ref)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning id`,
    [
      ctx.orgId,
      scenarioId,
      deps.agentId,
      deps.workflowId ?? null,
      passed,
      JSON.stringify({ assertions: details }),
      conversationId,
    ],
  );
  return run.rows[0]?.id as string;
}

const MAX_PERSONA_TURNS = 20;

/** Drive one scenario end-to-end; persist exactly one eval_runs row; return its result. */
export async function runScenario(
  deps: EvalDeps,
  ctx: OrgCtx,
  scenario: ParsedScenario,
): Promise<ScenarioResult> {
  // Wrap the injected send so this scenario's captures surface on the result, while the real
  // eval-mode capture port still records them for the caller (an eval never delivers a message).
  const captured: CapturedSend[] = [];
  const send: SendPort = async (c, msg) => {
    captured.push({ ctx: c, msg });
    return deps.send(c, msg);
  };
  const registry = buildCatalog({ send });

  const contactId = await resolveContactId(ctx, scenario.persona.name);
  const convo = await ctx.db.query(
    `insert into conversations (org_id, contact_id, agent_id, channel, direction, status)
     values ($1, $2, $3, 'whatsapp', 'inbound', 'active') returning id`,
    [ctx.orgId, contactId, deps.agentId],
  );
  const conversationId = convo.rows[0]?.id as string;
  const turnCtx: OrgCtx = { ...ctx, conversationId };
  const turnDeps = {
    provider: deps.provider,
    registry,
    toolsAllowed: deps.toolsAllowed,
    systemPrompt: deps.systemPrompt,
  };

  // Drive the conversation: each contact turn comes from the INJECTED player; each agent reply
  // goes through the REAL runTurn with the injected provider (never Anthropic in tests).
  const transcript: Msg[] = [];
  for (let i = 0; i < MAX_PERSONA_TURNS; i++) {
    const utterance = await deps.player(scenario, i, transcript);
    if (utterance === null || utterance === undefined) break;
    await appendContactMessage(ctx, conversationId, utterance);
    transcript.push({ role: "contact", content: utterance });
    await runTurn(turnDeps, turnCtx, conversationId);
  }

  const observed = await observe(
    ctx,
    conversationId,
    contactId,
    Array.isArray(scenario.assertions.must_capture)
      ? scenario.assertions.must_capture
      : [],
  );
  const details = evaluateAssertions(scenario.assertions, observed);
  const passed = details.every((d) => d.passed);
  const evalRunId = await persistRun(
    ctx,
    deps,
    scenario,
    passed,
    details,
    conversationId,
  );

  return {
    key: scenario.key,
    passed,
    scores: { assertions: details },
    conversationId,
    evalRunId,
    captured,
  };
}

/** Run all scenarios (or one, via opts.scenario); exit 1 if any fails, else 0. */
export async function runEvals(
  deps: EvalDeps,
  ctx: OrgCtx,
  opts?: { scenario?: string },
): Promise<EvalSummary> {
  const { scenarios, errors } = await loadScenarios(ctx, opts);
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    try {
      results.push(await runScenario(deps, ctx, scenario));
    } catch (err) {
      // A driving failure is a recorded scenario failure, never a crash of the whole run.
      results.push({
        key: scenario.key,
        passed: false,
        scores: { assertions: [] },
        captured: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // A malformed row is a recorded failure with an error, not a thrown run.
  for (const e of errors) {
    results.push({
      key: e.key ?? "(unparseable)",
      passed: false,
      scores: { assertions: [] },
      captured: [],
      error: e.error,
    });
  }

  const exitCode: 0 | 1 = results.every((r) => r.passed) ? 0 : 1;
  const summary = results
    .map(
      (r) =>
        `${r.passed ? "PASS" : "FAIL"} ${r.key}${r.error ? ` — ${r.error}` : ""}`,
    )
    .join("\n");
  return { results, exitCode, summary };
}
