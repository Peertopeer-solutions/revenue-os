// The company-filter guard `bun run guards` runs (scripts/guards/company-filter.ts): every SQL query the product runs
// names its company. Each case runs the real scripts/guards.sh in a throwaway git repo holding the files; the other
// guards find nothing there to fail. The fixtures are never run, only read by the guard. In the failing fixtures, each
// line the guard must name carries a mark saying what it must say there: `// ✗ <text>` after a one-line call, or
// `-- ✗ <text>` (an SQL comment, which the guard skips) on a line inside the SQL.
import { afterAll, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const GUARDS = join(import.meta.dir, "guards.sh");
const BANNER = "guard company filter ·";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function guards(
  files: Record<string, string>,
  { git = true, links = {} as Record<string, string> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "guards-company-"));
  dirs.push(dir);
  const all = { "docs/patterns/none.md": "# Pattern: none yet\n", ...files };
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  for (const [name, target] of Object.entries(links)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    symlinkSync(target, join(dir, name));
  }
  if (git)
    for (const args of [
      ["init", "-q"],
      ["add", "."],
    ])
      expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
  const r = spawnSync("bash", [GUARDS], { cwd: dir, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  // this guard's own lines: its banner up to the next guard's
  const at = out.indexOf(BANNER);
  const own = at < 0 ? "" : (out.slice(at).split(/\n(?=guard )/)[0] ?? "");
  return { code: r.status, out, own };
}

const UNFILTERED =
  'export const q = (tx) => tx.query("select * from contacts");\n';

it("passes every query that names its company, and reads only the product's code", () => {
  const { code, out, own } = guards({
    "packages/db/src/reads.ts": `// Every read the company filter accepts.
export async function reads(tx, orgId, id) {
  await tx.query("select id from contacts where org_id = $1 and id = $2", [orgId, id]);
  await tx.query(
    \`select c.id, ct.first_name
       from conversations c
       left join contacts ct on ct.org_id = $1 and ct.id = c.contact_id
       join tasks t on t.org_id = $1 and t.conversation_id = c.id
      where c.org_id = $1
      order by c.started_at desc nulls last\`,
    [orgId],
  );
  await tx.query(
    \`select c.id, latest.id as latest_conversation_id
       from contacts c
       left join lateral (
              select conv.id from conversations conv
               where conv.org_id = $1 and conv.contact_id = c.id
               order by conv.started_at desc nulls last, conv.created_at desc
               limit 1
            ) latest on true
      where c.org_id = $1 and c.deleted_at is null\`,
    [orgId],
  );
  await tx.query(
    \`select to_char(current_date - gs.n, 'YYYY-MM-DD') as day, coalesce(nl.c, 0)::int as new_leads
       from generate_series(0, 29) as gs(n)
       left join (select created_at::date as d, count(*) as c from contacts
                   where org_id = $1 and created_at::date between current_date - 29 and current_date
                   group by created_at::date) nl on nl.d = current_date - gs.n
       left join (select started_at::date as d, count(*) as c from conversations
                   where org_id = $1 group by started_at::date) cs on cs.d = current_date - gs.n
       left join (select occurred_at::date as d, count(*) as c from outcomes
                   where org_id = $1 and kind = 'booking' group by occurred_at::date) bk on bk.d = current_date - gs.n
      order by gs.n desc\`,
    [orgId],
  );
  await tx.query("select definition from workflows where id = $1 and (org_id = $2 or org_id is null)", [id, orgId]);
  await tx.query("select id from agents where (org_id = $1 or org_id is null)", [orgId]);
  await tx.query(
    \`select a.id from agents a
      where a.key = $1 and a.status = 'active' and (a.org_id is null or a.org_id = $2::uuid)
      order by a.version desc limit 1\`,
    ["caller", orgId],
  );
  await tx.query("select 1 from tasks where $1::uuid = org_id", [orgId]);
  await tx.query(
    \`select 1 from messages
      where org_id = $2 and conversation_id = $1 and role = 'contact'
        and seq > coalesce(
          (select max(seq) from messages where org_id = $2 and conversation_id = $1 and role in ('agent','tool')),
          0)
      limit 1\`,
    [id, orgId],
  );
  await tx.query(
    \`select attempts from workflow_runs
      where id = $1 and org_id = $2 and status in ('pending', 'waiting')
      for update skip locked\`,
    [id, orgId],
  );
  await tx.query<{ id: string }>("select id from tasks where org_id = $1 for no key update", [orgId]);
  await tx.query(
    \`select extract(day from c.created_at) as day from contacts c, tasks t
      where c.org_id = $1 and t.org_id = $1 and t.contact_id = c.id and c.first_name is distinct from $2\`,
    [orgId, "Asha"],
  );
  await tx.query(
    \`select c.id from contacts a
       join tasks t on t.org_id = $1 and t.contact_id = a.id, conversations c
      where a.org_id = $1 and c.org_id = $1\`,
    [orgId],
  );
  await tx.query(
    \`select id from contacts where org_id = $1
     union all
     select id from tasks where org_id = $1\`,
    [orgId],
  );
  await tx.query("select c.id from public.contacts c where c.org_id = $1", [orgId]);
  await tx.query("select id from postgres.public.contacts where public.contacts.org_id = $1", [orgId]);
  await tx.query?.("select id from contacts where org_id = $1", [orgId]);
  await tx.query!("select id from tasks where org_id = $1", [orgId]);
  await tx.query("select name from orgs where id = $1 for update", [orgId]);
  await tx.query("select org_id from app.due_org_ids() as org_id");
  await tx.query("select org_id as id, name from app.user_orgs($1) order by name", [id]);
}
`,
    "packages/db/src/writes.ts": `// Every insert, update and delete the company filter accepts.
export async function writes(tx, orgId, id, first) {
  await tx.query(
    \`insert into guardrail_policies (org_id, key, config, active)
     values ($1, $2, $3::jsonb, $4)
     on conflict (org_id, key) do update set config = excluded.config, updated_at = now()
     returning key\`,
    [orgId, "quiet_hours", "{}", true],
  );
  await tx.query(
    \`insert into contacts as c (org_id, id, first_name) values ($1, $2, $3)
     on conflict (id) do update set first_name = excluded.first_name where c.org_id = $1\`,
    [orgId, id, first],
  );
  await tx.query(
    \`with new_memory as (
       insert into contact_memories (org_id, contact_id, kind, content) values ($1, $2, 'summary', $3) returning id
     )
     update contact_memories set superseded_by = new_memory.id
       from new_memory
      where contact_memories.org_id = $1 and contact_memories.contact_id = $2
        and contact_memories.id <> new_memory.id\`,
    [orgId, id, "summary"],
  );
  await tx.query("insert into orgs (id, name, slug) values ($1, $2, $3)", [orgId, "Acme", "acme"]);
  await tx.query("update orgs set name = $2, updated_at = now() where id = $1 returning name", [orgId, "Acme"]);
  await tx.query(
    \`insert into pgboss.job_common (name, data, singleton_key, policy)
     values ($1, $2::jsonb, $3, 'short')
     on conflict do nothing\`,
    ["agent_turn", "{}", id],
  );
  await tx.query(
    "update contacts set first_name = coalesce($3, first_name) where id = $1 and org_id = $2",
    [id, orgId, first ?? null],
  );
  await tx.query("delete from tasks t where t.org_id = $1 and t.id = $2", [orgId, id]);
}
`,
    "packages/db/src/conversations.ts": `// The one writer of messages may insert into it.
export async function add(tx, orgId, id) {
  await tx.query(
    \`insert into messages (org_id, conversation_id, seq, role, content)
     select $1, $2, coalesce(max(seq), 0) + 1, $3, $4 from messages where org_id = $1 and conversation_id = $2
     on conflict (org_id, conversation_id, seq) do nothing\`,
    [orgId, id, "contact", "hello"],
  );
}
`,
    "services/worker/src/plumbing.ts": `// Calls that touch no company table, and .query text that is no call.
export async function plumbing(client, orgId, c) {
  await client.query("begin");
  await client.query("select set_config('request.org_id', $1, true)", [orgId]);
  await client.query("savepoint vapi_event");
  await client.query("rollback to savepoint vapi_event");
  await client.query("commit");
  await client.query("select 1 as ok");
  // await client.query("select * from contacts");
  /* client.query(\`delete from tasks\`) */
  const half = 10 / 2 / 1;
  const name = c.req.query("from");
  const el = document.querySelector("select");
  return [half, name, el];
}
`,
    "scripts/demo.ts":
      'export const q = (tx, o) => tx.query("select id from tasks where org_id = $1", [o]);\n',
    "packages/db/src/reads.test.ts": UNFILTERED,
    "packages/db/test/helper.ts": UNFILTERED,
    "services/worker/e2e/flow.ts": UNFILTERED,
    "apps/console/src/rows.spec.tsx": UNFILTERED,
    "packages/db/src/types.d.ts": UNFILTERED,
    "scripts/seed.ts": UNFILTERED,
    "scripts/evals.ts": UNFILTERED,
    "scripts/proof/step.ts": UNFILTERED,
    "scripts/done-gate/check.ts": UNFILTERED,
    "scripts/guards/other.ts": UNFILTERED,
    "tests/helper.ts": UNFILTERED,
  });
  expect(own).toContain(BANNER);
  expect(own).toMatch(/\n\s+PASS \(37 queries in 5 files\)/);
  expect(out).not.toContain("FAIL");
  expect(code).toBe(0);
}, 30_000);

const BAD = `// Every query the company filter refuses, each line marked with what it must say there.
export async function bad(tx, pool, orgId, id, sql, extra, table, sets) {
  await tx.query("select id from contacts where id = $1", [id]); // ✗ contacts is read without its company
  await tx.query("update tasks set status = 'done' where id = $1", [id]); // ✗ tasks is updated without its company
  await tx.query("delete from tasks where id = $1", [id]); // ✗ tasks is deleted from without its company
  await tx.query("select id from contacts where org_id = $1 or id = $2", [orgId, id]); // ✗ contacts is read
  await tx.query("select id from contacts where not org_id = $1", [orgId]); // ✗ contacts is read
  await tx.query("select id from contacts where case when org_id = $1 then true else false end", [orgId]); // ✗ contacts is read
  await tx.query("select id from contacts where org_id = any($1)", [[orgId]]); // ✗ contacts is read
  await tx.query("select id from contacts where (org_id = $1 or org_id is null)", [orgId]); // ✗ contacts is read
  await tx.query(
    \`select c.id
       from conversations c
       left join contacts ct on ct.id = c.contact_id -- ✗ contacts (as ct) is read
      where c.org_id = $1\`,
    [orgId],
  );
  await tx.query(
    \`select c.id
       from conversations c
       join contacts ct on ct.id = c.contact_id and ct.org_id = c.org_id -- ✗ contacts (as ct) is read
      where c.org_id = $1\`,
    [orgId],
  );
  await tx.query(
    \`select c.id
       from conversations c -- ✗ conversations (as c) is read
       left join contacts ct on ct.id = c.contact_id and ct.org_id = $1 and c.org_id = $1\`,
    [orgId],
  );
  await tx.query(
    \`select c.id from contacts c
       right join tasks t on t.org_id = $1 and t.contact_id = c.id -- ✗ tasks (as t) is read
      where c.org_id = $1\`,
    [orgId],
  );
  await tx.query(
    \`select id from contacts
      where org_id = $1
        and id in (select contact_id from tasks where status = 'open')\`, // ✗ tasks is read
    [orgId],
  );
  await tx.query(
    \`select c.id from contacts a
       join tasks t on t.org_id = $1 and t.contact_id = a.id, conversations c -- ✗ conversations (as c) is read
      where a.org_id = $1\`,
    [orgId],
  );
  await tx.query("with contacts as (select 1) select first_name from public.contacts", []); // ✗ contacts is read
  await tx.query("with tasks as (select * from tasks) select * from tasks", []); // ✗ tasks is read
  await tx.query("select id from agents a, workflows w where (a.org_id = $1 or w.org_id is null) and w.org_id = $1", [orgId]); // ✗ agents (as a) is read
  await tx.query("delete from tasks t using contacts c where t.org_id = $1 and t.contact_id = c.id", [orgId]); // ✗ contacts (as c) is read
  await tx.query("select t.id from tasks t where t.org_id = $1 and exists (select 1 from profiles where org_id = $1)", [orgId]); // ✗ profiles is read, a table with no org_id
  await tx.query("select p.id from tasks p, app.user_orgs($2) where org_id = $1", [orgId, id]); // ✗ tasks (as p) is read
  await tx.query("select id from contacts where id = $1 -- and org_id = $2", [id, orgId]); // ✗ contacts is read
  await tx.query("select id from contacts where first_name = 'org_id = $1'", [orgId]); // ✗ contacts is read
  await tx.query("select org_id = $1 as mine from contacts", [orgId]); // ✗ contacts is read
  await tx.query(\`select id from contacts where org_id = $1 \${extra}\`, [orgId]); // ✗ a \${…} piece
  await tx.query(\`update contacts set \${sets} where org_id = $1\`, [orgId]); // ✗ a \${…} piece
  await tx.query(\`select id from \${table} where org_id = $1\`, [orgId]); // ✗ a \${…} piece
  await tx.query("insert into tasks (kind, title) values ($1, $2)", ["call", "Call back"]); // ✗ inserts into tasks without org_id among its columns
  await tx.query("insert into tasks values ($1, $2)", [orgId, "Call back"]); // ✗ inserts into tasks without a column list
  await tx.query("insert into contacts (org_id, id, first_name) values ($1, $2, $3) on conflict (id) do update set first_name = excluded.first_name", [orgId, id, "A"]); // ✗ contacts is updated on conflict without its company
  await tx.query("select name from orgs where slug = $1", [id]); // ✗ orgs is read without id = $n
  await tx.query("table contacts"); // ✗ a TABLE x read
  await tx.query("select id from contacts where org_id = $1 union all table contacts", [orgId]); // ✗ a TABLE x read
  await tx.query("truncate tasks"); // ✗ a truncate statement
  await tx.query("with tasks as (select 1) insert into tasks (org_id, contact_id, kind, title) values ($1, $2, 'review', 't')", [orgId, id]); // ✗ inserts into tasks, which only packages/db/src/tasks.ts writes
  await tx.query("with contacts as (select 1) update contacts set first_name = $1", ["A"]); // ✗ contacts is updated
  await tx.query("with x as (select 1) merge into tasks t using contacts c on t.contact_id = c.id when matched then delete", []); // ✗ a merge statement
  await tx.query("select * from auth.users"); // ✗ auth.users, a table in a schema this guard doesn't know
  await tx.query("select * from contacts where $$ and org_id = $1 and $$ <> $1::text", [orgId]); // ✗ SQL this guard would read differently
  await tx.query("select * from contacts where (E'\\\\' and org_id = $1 and \\\\'' <> '')", [orgId]); // ✗ SQL this guard would read differently
  await tx.query("select * from contacts /* /* */ where org_id = $1 and true */", [orgId]); // ✗ SQL this guard would read differently
  await tx.query(sql, [orgId]); // ✗ the SQL is not written at this call
  await tx.query("select id from contacts where " + extra, [orgId]); // ✗ the SQL is not written at this call
  await tx.query.call(tx, "select * from contacts"); // ✗ query is used other than as a direct call
  await tx.query?.("select * from contacts"); // ✗ contacts is read
  const req = await pool.connect();
  await req.query("select * from contacts"); // ✗ contacts is read
  const text = "client.query('select 1')"; // ✗ .query( inside a string
  const pattern = /a.query(b)/; // ✗ .query( inside a string, template or regex
  return [text, pattern];
}
`;

it("fails each query that leaves its company out, naming its file, line and what is missing", () => {
  const files: Record<string, string> = {
    "packages/db/src/bad.ts": BAD,
    "apps/console/src/rows.tsx": `export const Rows = ({ rows }) => <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>;
export const load = (db) => db.query("select id from tasks where status = 'open'"); // ✗ tasks is read
export const Empty = (db) => <p>Nobody's here</p> && db.query("select id from outcomes"); // ✗ outcomes is read
`,
    "services/worker/src/job.mjs":
      'export const run = (tx) => tx.query("delete from usage_events where id = $1", [1]); // ✗ usage_events is deleted from\n',
    "packages/shared/src/old.cjs":
      'module.exports = (tx) => tx.query("update contacts set first_name = $1", ["Asha"]); // ✗ contacts is updated\n',
    "packages/channels/src/tagged.js":
      "export const q = (tx, sql) => tx.query(sql`select id from contacts`); // ✗ the SQL is not written at this call\n",
    "packages/db/src/tests/inner.ts": `${UNFILTERED.trimEnd()} // ✗ contacts is read\n`,
    "scripts/tool.ts": `${UNFILTERED.trimEnd()} // ✗ contacts is read\n`,
    "packages/db/src/open.ts":
      "export const x = `never closed // ✗ .query( inside a string\nexport const q = (tx) => tx.query('select * from tasks');\n",
    "lib/real.ts": UNFILTERED,
  };
  const { code, own } = guards(files, {
    links: { "packages/db/src/linked.ts": "../../../lib/real.ts" },
  });
  const expected: Record<string, string[]> = {};
  for (const [file, body] of Object.entries(files))
    body.split("\n").forEach((line, n) => {
      for (const [, what = ""] of line.matchAll(/(?:\/\/|--) ✗ ([^\n]*)/g)) {
        const at = `${file}:${n + 1}`;
        expected[at] = [
          ...(expected[at] ?? []),
          what.replace(/\\\$/g, "$").trim(),
        ];
      }
    });
  const reported: Record<string, string> = {};
  for (const [, at = "", what = ""] of own.matchAll(/^ {2}(\S+:\d+): (.*)$/gm))
    reported[at] = `${reported[at] ?? ""}${what}\n`;
  expect(Object.keys(reported).sort()).toEqual(Object.keys(expected).sort());
  for (const [at, whats] of Object.entries(expected))
    for (const what of whats) expect(`${at}: ${reported[at]}`).toContain(what);
  expect(own).toContain(
    "packages/db/src/open.ts: ends inside a template literal or a comment",
  );
  expect(own).toContain(
    "packages/db/src/linked.ts: a link, which this guard does not follow",
  );
  expect(own).toContain("FAIL — company filter");
  expect(own).toContain("docs/patterns/drizzle-query.md");
  expect(code).toBe(1);
}, 30_000);

// Tasks, audit rows and memberships each have one writer in packages/db (createTask, audit, the member functions of
// orgs.ts): their own file may insert into the table, and any other product file that does fails, naming the owner.
const INSERTS = {
  tasks:
    'db.query("insert into tasks (org_id, contact_id, kind, title) values ($1, $2, $3, $4)", [o, c, "review", "t"])',
  audit_log:
    'db.query("insert into audit_log (org_id, actor_type, action) values ($1, $2, $3)", [o, "system", "x"])',
  org_members:
    'db.query("insert into org_members (org_id, user_id, role) values ($1, $2, $3)", [o, u, "viewer"])',
};
const writer = (table: keyof typeof INSERTS) =>
  `export const write = (db, o, c, u) => ${INSERTS[table]};\n`;

it("lets each table's own file insert into it, and fails any other product file that does, naming the file that may", () => {
  const files = {
    "packages/db/src/tasks.ts": writer("tasks"),
    "packages/db/src/audit.ts": writer("audit_log"),
    "packages/db/src/orgs.ts": `${writer("org_members")}${writer("audit_log").replace("write", "writeAudit")}`,
    "services/worker/src/handlers/call-post.ts": writer("tasks"),
    "packages/harness/src/audit.ts": writer("audit_log"),
    "packages/db/src/members.ts": writer("org_members"),
    "apps/console/src/tasks.ts": writer("tasks"),
  };
  const { code, own } = guards(files);
  for (const [file, owner, table] of [
    [
      "services/worker/src/handlers/call-post.ts",
      "packages/db/src/tasks.ts",
      "tasks",
    ],
    ["packages/harness/src/audit.ts", "packages/db/src/audit.ts", "audit_log"],
    ["packages/db/src/members.ts", "packages/db/src/orgs.ts", "org_members"],
    ["apps/console/src/tasks.ts", "packages/db/src/tasks.ts", "tasks"],
    ["packages/db/src/orgs.ts:2", "packages/db/src/audit.ts", "audit_log"],
  ])
    expect(own).toContain(
      `${file.includes(":") ? file : `${file}:1`}: inserts into ${table}, which only ${owner} writes: call its function instead`,
    );
  // Each owner's own insert is never named: only orgs.ts's second line, an audit row it may not write.
  for (const owner of [
    "packages/db/src/tasks.ts:",
    "packages/db/src/audit.ts:",
    "packages/db/src/orgs.ts:1:",
  ])
    expect(own).not.toContain(owner);
  expect(own).toContain("FAIL — company filter");
  expect(code).toBe(1);
}, 30_000);

// Conversations and messages have one writer, packages/db/src/conversations.ts (openConversation, addMessage,
// finishConversation): every insert, update or delete of either anywhere else fails, naming that file; reads pass.
it("lets only conversations.ts write conversations and messages, and fails any other product file's insert, update or delete", () => {
  const convo = `export const writes = (db, o, c) => [
  db.query("insert into conversations (org_id, channel, direction) values ($1, 'voice', 'inbound')", [o]),
  db.query("update conversations set status = 'completed' where org_id = $1 and id = $2", [o, c]),
  db.query("insert into messages (org_id, conversation_id, seq, role) values ($1, $2, 1, 'agent')", [o, c]),
  db.query("delete from messages where org_id = $1 and conversation_id = $2", [o, c]),
  db.query("select id from conversations where org_id = $1 and id = $2 for update", [o, c]),
];
`;
  const { code, own } = guards({
    "packages/db/src/conversations.ts": convo,
    "services/worker/src/vapi/process.ts": convo,
  });
  const owner = "packages/db/src/conversations.ts";
  for (const [line, what] of [
    [2, "inserts into conversations"],
    [3, "updates conversations"],
    [4, "inserts into messages"],
    [5, "deletes from messages"],
  ])
    expect(own).toContain(
      `services/worker/src/vapi/process.ts:${line}: ${what}, which only ${owner} writes: call its function instead`,
    );
  expect(own).not.toContain("services/worker/src/vapi/process.ts:6");
  expect(own).not.toContain(`${owner}:`);
  expect(own).toContain("FAIL — company filter");
  expect(code).toBe(1);
}, 30_000);

it("fails loudly outside a git checkout, where it can list no files: nothing was checked", () => {
  const { code, own } = guards(
    { "packages/db/src/x.ts": UNFILTERED },
    { git: false },
  );
  expect(own).toMatch(
    /^guard company filter ·[^\n]*\n {2}FAIL — company filter: [^\n]*nothing was checked/,
  );
  expect(code).toBe(1);
}, 30_000);
