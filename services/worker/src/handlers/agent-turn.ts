// The run_agent_turn job handler: the generic bridge to the harness turn loop. No database transaction is open while
// the AI model thinks, so a slow or stuck model never holds the conversation locked; every query also filters by the
// job's company.
//   1. In one short transaction: reload the conversation FOR UPDATE; NO-OP if this trigger was already processed. The
//      per-trigger marker is DURABLE and message-derived (NOT the conversation status column): a turn answers the
//      latest unanswered inbound, so once an agent/tool message sits after every contact message there is nothing to
//      process. Then load the conversation's agent (the company's own or a shared template: system_prompt +
//      tools_allowed).
//   2. runTurn with OrgUnits: each round reads in a short transaction, asks the model (within its time limit) with
//      none open, and saves in another, so messages + usage_events land. A pg-boss re-delivery that runs at the same
//      time saves its answer ONCE: the save finds a message added since it read and stops (packages/harness/src/loop.ts).

import type { ToolRegistry } from "@harness/registry";
import type { LlmProvider } from "@harness/types";
import { withOrg } from "@revenue-os/db";
import { runTurn } from "@revenue-os/harness";
import type { Pool } from "pg";
import { TIME_LIMITS, type TimeLimits } from "../time-limits";

export type AgentTurnDeps = {
  pool: Pool;
  provider: LlmProvider;
  registry: ToolRegistry;
  limits?: Partial<TimeLimits>; // TIME_LIMITS where unset
  now?: () => Date;
};

export type AgentTurnJob = {
  orgId: string;
  runId: string;
  action: { kind: "run_agent_turn"; conversationId: string };
};

export async function handleAgentTurn(
  deps: AgentTurnDeps,
  job: AgentTurnJob,
): Promise<void> {
  const { orgId, action } = job;
  const conversationId = action.conversationId;

  // 1. lock the conversation, check there is an inbound to answer, and read its agent; the lock ends with this transaction.
  const agent = await withOrg(deps.pool, orgId, async (tx) => {
    const convo = (
      await tx.query(
        `select id, agent_id from conversations where id = $1 and org_id = $2 for update`,
        [conversationId, orgId],
      )
    ).rows[0];
    if (!convo) return; // RLS-hidden or gone

    // per-trigger idempotency: is there an inbound message NOT yet answered by an agent/tool turn?
    const pending = await tx.query(
      `select 1 from messages
        where org_id = $2 and conversation_id = $1 and role = 'contact'
          and seq > coalesce(
            (select max(seq) from messages
              where org_id = $2 and conversation_id = $1 and role in ('agent','tool')),
            0)
        limit 1`,
      [conversationId, orgId],
    );
    if ((pending.rowCount ?? 0) === 0) return; // already processed — exactly-once

    return (
      await tx.query(
        `select system_prompt, tools_allowed from agents
          where id = $1 and (org_id = $2 or org_id is null)`,
        [convo.agent_id, orgId],
      )
    ).rows[0]; // none: the conversation has no resolvable agent
  });
  if (!agent) return;

  // 2. drive the turn, each database step in its own short transaction.
  await runTurn(
    {
      provider: deps.provider,
      registry: deps.registry,
      toolsAllowed: (agent.tools_allowed as string[] | null) ?? [],
      systemPrompt: (agent.system_prompt as string | null) ?? "",
      modelTimeLimitMs: deps.limits?.model ?? TIME_LIMITS.model,
    },
    {
      orgId,
      inTransaction: (work) =>
        withOrg(deps.pool, orgId, (tx) => work({ orgId, db: tx })),
    },
    conversationId,
  );
}
