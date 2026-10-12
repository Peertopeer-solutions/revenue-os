# Pattern: company-scoped SQL query (the file name is historical)
No query in this codebase uses Drizzle, so the Drizzle example that stood here is deleted, and so are Drizzle's unused
copy of three tables and the library itself (entry 2 of `docs/fix-when-touched.md`). Every query is
parameterised SQL through `tx.query` inside `withOrg` (`packages/db/src/client.ts`), with the company in its where
clause as well as in the database's own per-company rules:

```ts
// packages/db/src/agents.ts
export async function listAgentsAndWorkflows(
  pool: pg.Pool,
  orgId: string,
): Promise<{ agents: AgentRow[]; workflows: WorkflowRow[] }> {
  return withOrg(pool, orgId, async (tx) => {
    …
    const agents = await tx.query(
      `select id, key, version, status, model, created_at::text as created_at
         from agents
        where org_id = $1
        order by key asc, version desc`,
      [orgId],
    );
    …
  });
}
```
**Not every query does this yet.** About 40 SQL statements in product code, in some 20 functions, leave the company out of the where clause (counted on 2026-10-03, leaving out lookups of the company row itself and the scheduler's deliberate scan of every company's due runs), among them `listTasks`
(`packages/db/src/tasks.ts`), `listConversations` (`packages/db/src/conversations.ts`) and `funnelMetrics`
(`packages/db/src/metrics.ts`) and the contact update in
`packages/harness/src/tools/update-contact.ts`: don't copy a query without reading its where clause. Slice 1 ·
"Every database query also filters by company…" adds the filter everywhere, adds a check that fails a query
without it, and makes this file an excerpt of that code.

Rules: `org_id` in every where clause (the database's per-company rules are the net, not the plan) · values only
through `$n` parameters, never joined into the SQL text · one query at a time on a transaction's connection.
