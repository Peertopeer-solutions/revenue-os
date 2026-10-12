# Pattern: company-scoped SQL query (the file name is historical)
No query in this codebase uses Drizzle, so the Drizzle example that stood here is deleted, and so are Drizzle's unused
copy of three tables and the library itself (entry 2 of `docs/fix-when-touched.md`). Every query is parameterised SQL
through `tx.query` inside `withOrg` (`packages/db/src/client.ts`), and names its company in its where clause as well as
in the database's own per-company rules, so a query that ever runs without those rules still sees only its company.

The table a query reads and the table it joins each carry their own condition; a left join's `on` filters only the
joined table:

```ts
// packages/db/src/conversations.ts
export async function listConversations(
  pool: pg.Pool,
  orgId: string,
): Promise<ConversationRow[]> {
  return withOrg(pool, orgId, async (tx) => {
    const result = await tx.query(
      `select c.id, c.channel, c.status, c.direction,
              nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as contact_name,
              c.started_at::text as started_at, c.ended_at::text as ended_at
         from conversations c
         left join contacts ct on ct.org_id = $1 and ct.id = c.contact_id
        where c.org_id = $1
        order by c.started_at desc nulls last
        limit 100`,
      [orgId],
    );
    return result.rows;
  });
}
```

A shared template (an agent, sequence or eval scenario with no company) stays readable beside the company's own:

```ts
// services/worker/src/runs.ts
  return withOrg(pool, orgId, async (tx) => {
    const wf = await tx.query<{ definition: unknown }>(
      `select definition from workflows where id = $1 and (org_id = $2 or org_id is null)`,
      [input.workflowId, orgId],
    );
    const wfRow = wf.rows[0];
    if (!wfRow) {
      throw new Error(`workflow not found: ${input.workflowId}`);
    }
```

Rules:
- Every table a query reads, changes or deletes from carries `org_id = $n` as an and-condition of its own level's
  where clause, or of its own join's `on`. A shared template table (`agents`, `workflows`, `eval_scenarios`) may read
  `(org_id = $n or org_id is null)`; the company row itself is `orgs … where id = $n`.
- An insert lists `org_id` among its columns; an `on conflict … do update` has `org_id` in its conflict key.
- A read that must look across companies goes through an `app.*` security-definer function (`app.due_org_ids`,
  `app.user_orgs`), never a query without the company.
- The SQL is one literal at the call, values only through `$n` parameters: never a `${…}` piece or text joined on.
- One query at a time on a transaction's connection.

`bun run guards` (`scripts/guards/company-filter.ts`) fails a query in apps, services, packages or scripts that breaks
these rules.
