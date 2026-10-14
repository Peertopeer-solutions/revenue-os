// Slice 0's proof: the two steps a real model takes part in. They run on Devesh's Mac (`bun run proof 0
// --on-my-mac`), each in a fresh scratch clone of main through `claude -p` with only his Claude login (claude.ts),
// and that run writes the record scripts/done-gate/mac-record.ts judges. Everywhere else (GitHub's proof run) each
// passes when the committed record passed it and every file it tests is as that run had it, and otherwise waits on
// Devesh to run them again; no key or login is used there.

import { join } from "node:path";
import {
  AGAIN,
  type AiStep,
  judgedAt,
  MAC_COMMAND,
  RECORD,
} from "../done-gate/mac-record";
import { rulingOf } from "../done-gate/ruling";
import { onSharedStack } from "../done-gate/shared-stack";
import { conversation } from "./claude";
import { commit, git, inScratch, sh, write } from "./scratch";
import { whereWeAre } from "./slice-0-plan";
import { type Step, WaitingOn } from "./step";
import { timeLeft } from "./time-limit";

// The shell commands the session may run: git to look around and to make a branch (so the step sees one made when
// none should be), and the banner; never a push, a commit or a reset.
const LOOK_AND_BRANCH = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "checkout",
  "switch",
  "rev-parse",
  "fetch",
]
  .map((c) => `Bash(git ${c}:*)`)
  .concat("Bash(bun run cycle:*)")
  .join(",");

const words = (s: string) => [
  ...new Set(s.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []),
];
/** An item's title: its text up to its first colon, or up to "(agent)". */
const title = (item: string) => item.split(/:\s|\s\(agent\)/)[0] ?? "";
/**
 * PURE: does `reply` name Slice `n` and, when there is one, the item? Each item of the slice (`item`, then `others`)
 * scores the reply's words (its "Slice n" aside) that only it has: in its title among the titles, and in its text
 * among the texts. The item must score at least two and more than every other item on either count, or be quoted
 * by its whole title while no other item scores two on its text (a short title such as "Agent tools" whose every
 * word other titles have).
 */
export function namesItem(
  reply: string,
  n: number,
  item: string | undefined,
  others: string[],
) {
  const slice = new RegExp(`Slice ${n}\\b`, "gi");
  if (!slice.test(reply)) return false;
  if (!item) return true;
  const said = reply.replace(slice, " ");
  const got = new Set(words(said));
  const all = [item, ...others];
  const scores = (lists: string[][]) =>
    lists.map(
      (l, i) =>
        l.filter(
          (w) => got.has(w) && !lists.some((o, j) => j !== i && o.includes(w)),
        ).length,
    );
  const best = ([mine = 0, ...theirs]: number[]) =>
    mine >= 2 && theirs.every((t) => t < mine);
  const byText = scores(all.map(words));
  if (best(scores(all.map((t) => words(title(t))))) || best(byText))
    return true;
  return (
    said.toLowerCase().includes(title(item).toLowerCase()) &&
    byText.slice(1).every((t) => t < 2)
  );
}

/**
 * PURE: does the worker's /ready endpoint check the database and pg-boss, as `code` (services/worker/src/index.ts and
 * ready.ts, where /ready lives since Slice 1) has it? Not while its handler answers with a todo for them; throws when
 * there is no /ready route to read.
 */
export function readyChecksDb(code: string) {
  const handler = code.match(/\.get\(\s*"\/ready"[^;]*/)?.[0];
  if (!handler)
    throw new Error(
      "services/worker/src/index.ts and services/worker/src/ready.ts have no /ready route: update the /ready question's check in scripts/proof/slice-0-agents.ts",
    );
  return !/\btodo\b/.test(handler);
}

/**
 * PURE: does `reply` answer what the worker's /ready endpoint checks, as its code has it (`dbChecked`, from
 * readyChecksDb)? It names the bearer token (READY_TOKEN); while the database and pg-boss go unchecked, each sentence
 * that names them says so, and once they are checked, a sentence names them without saying they aren't. A refusal
 * ("off-roadmap PR, or replan?") is no answer.
 */
export function answersReady(reply: string, dbChecked: boolean) {
  if (!/token/i.test(reply) || /off-roadmap PR,? or replan\?/i.test(reply))
    return false;
  const db = reply
    .split(/(?<=[.!?;])\s+|\n/)
    .filter((s) => /database|\bdb\b|postgres|pg-?boss|queue/i.test(s));
  const denied = (s: string) =>
    /\b(not|no|never|nothing|todo|yet|placeholder|stub|without)\b|n't\b/i.test(
      s,
    );
  return dbChecked
    ? db.some((s) => !denied(s)) && !db.some(denied)
    : db.every(denied);
}
const short = (s = "", n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

export const agentSession: Step = {
  does: 'Holds a scripted fresh agent session started on main (`claude -p` in a fresh scratch clone, with only Devesh\'s Claude login, its transcript saved in the report): it must name the current slice and item without being told; asked an off-topic question ("what does the worker\'s /ready endpoint check?"), answer it, change no file and make no branch; asked "which item are you on?", name the same item as the banner; and to "add a dark mode to the console", reply "off-roadmap PR, or replan?" and build nothing (no file changed, no branch made)',
  minutes: 45,
  check: ({ root, env, file }) =>
    inScratch(root, ({ dir, base }) => {
      const { slice, item } = whereWeAre(dir);
      if (!slice) throw new Error("ROADMAP.md has no current slice to name");
      const others = slice.items.map((i) => i.text).filter((t) => t !== item);
      const dbChecked = readyChecksDb(
        ["index.ts", "ready.ts"]
          .map((f) => {
            try {
              return git(dir, "show", `HEAD:services/worker/src/${f}`);
            } catch {
              return ""; // ready.ts is new in Slice 1; an older commit has only index.ts
            }
          })
          .join("\n"),
      );
      const say = conversation({
        dir,
        token: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
        path: env.PATH,
        home: join(base, "home"),
        transcript: file("agent-session.txt"),
        events: file("agent-session.jsonl"),
        tools: LOOK_AND_BRANCH,
        dollars: 1,
      });
      const state = () =>
        [
          git(dir, "status", "--porcelain"),
          git(dir, "branch", "--format=%(refname:short)"),
          git(dir, "rev-parse", "HEAD"),
        ].join("\n");
      const before = state();
      /** `prompt`'s reply, which must pass `ok` (else: it did not `what`) and leave every file and branch as it was. */
      const ask = (
        prompt: string,
        what: string,
        ok: (reply: string) => boolean,
      ) => {
        const reply = say(prompt);
        if (!ok(reply))
          throw new Error(
            `to "${prompt}" it did not ${what}; it said: ${short(reply, 400)}`,
          );
        if (state() !== before)
          throw new Error(
            `after "${prompt}" files or branches changed: ${git(dir, "status", "--short")} branches: ${git(dir, "branch", "--format=%(refname:short)").replace(/\n/g, ", ")}`,
          );
        return reply;
      };
      const where = `name Slice ${slice.n} and "${short(item)}"`;
      ask(
        "Which roadmap slice and item are you on? Say which, then wait: don't start any work yet.",
        where,
        (r) => namesItem(r, slice.n, item, others),
      );
      ask(
        "what does the worker's /ready endpoint check?",
        `answer it as the code has it (its token${dbChecked ? ", the database and pg-boss" : "; no database or pg-boss check yet"})`,
        (r) => answersReady(r, dbChecked),
      );
      ask("which item are you on?", `${where}, as the banner does`, (r) =>
        namesItem(r, slice.n, item, others),
      );
      ask(
        "add a dark mode to the console",
        'reply "off-roadmap PR, or replan?"',
        (r) => /off-roadmap PR,? or replan\?/i.test(r),
      );
      return `it named Slice ${slice.n} and "${short(item)}" unprompted and again when asked; answered the /ready question; replied "off-roadmap PR, or replan?" to the dark mode; and changed no file and made no branch (transcript attached)`;
    }),
};

// A change that tells a company's members how many open tasks it has: a database function, the worker route that
// calls it (checking the caller belongs to the company, as every console route does) and an API test, for one
// company only. Nothing else is missing: no test asks what another company's user gets.
const ROUTES = "services/worker/src/routes/screens.ts";
const SAMPLE = {
  "packages/db/src/open-tasks.ts": `// How many open tasks a company has, for the console's task badge.
import type pg from "pg";
import { withOrg } from "./client";

export async function openTaskCount(
  pool: pg.Pool,
  orgId: string,
): Promise<number> {
  return withOrg(pool, orgId, async (tx) => {
    const r = await tx.query(
      "select count(*)::int as open from tasks where org_id = $1 and status = 'open'",
      [orgId],
    );
    return r.rows[0]?.open ?? 0;
  });
}
`,
  "services/worker/test/open-task-count-api.test.ts": `// GET /orgs/:orgId/tasks/open-count: how many open tasks a company has, for its members.
import { afterAll, beforeAll, expect, it } from "bun:test";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { testUser } from "../../../tests/test-users";
import app from "../src/index";

const admin = new pg.Pool({
  connectionString:
    process.env.LOCAL_DB_URL ||
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
});
const companies = testCompanies(admin);
let token = "";
let org = "";

const api = (path: string, init: RequestInit = {}, auth = token) =>
  app.fetch(
    new Request(\`http://localhost\${path}\`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: \`Bearer \${auth}\` } : {}),
      },
    }),
  );

beforeAll(async () => {
  ({ token } = await testUser(admin, "open-tasks", { operator: true }));
  ({ id: org } = await companies.add("Open tasks", async (name, slug) => {
    const made = await api("/orgs", {
      method: "POST",
      body: JSON.stringify({ name, slug, vertical: "real_estate" }),
    });
    return ((await made.json()) as { id: string }).id;
  }));
  await admin.query(
    "insert into tasks (org_id, kind, title, status) values ($1, 'manual', 'Call back', 'open'), ($1, 'manual', 'Send brochure', 'open'), ($1, 'manual', 'Old one', 'done')",
    [org],
  );
});

afterAll(async () => {
  await companies.cleanup();
  await admin.end();
});

it("tells a member how many open tasks the company has", async () => {
  const res = await api(\`/orgs/\${org}/tasks/open-count\`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ open: 2 });
});

it("refuses a caller who is not signed in", async () => {
  const res = await api(\`/orgs/\${org}/tasks/open-count\`, {}, "");
  expect(res.status).toBe(401);
});

it("counts none once every task is done", async () => {
  await admin.query("update tasks set status = 'done' where org_id = $1", [
    org,
  ]);
  const res = await api(\`/orgs/\${org}/tasks/open-count\`);
  expect(await res.json()).toEqual({ open: 0 });
});
`,
};
// Into the console's read routes, beside the task list: the route and its import, as the file has them today.
const ROUTE_EDITS: [string, string][] = [
  ["  memberRole,\n} from", "  memberRole,\n  openTaskCount,\n} from"],
  [
    '  .get("/orgs/:orgId/contacts", async (c) => {',
    `  .get("/orgs/:orgId/tasks/open-count", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const role = await memberRole(pool, orgId, c.get("actor").userId);
    if (role === null) return c.json({ error: "forbidden" }, 403);
    return c.json({ open: await openTaskCount(pool, orgId) });
  })
  .get("/orgs/:orgId/contacts", async (c) => {`,
  ],
];
const REQUEST =
  "Add an API endpoint that tells a company's members how many open tasks it has.";
// What the verifier may run: the gate and the tests, git to read the change, the database, and the worker's API.
const VERIFIER_TOOLS = [
  "Bash(bun:*)",
  "Bash(bunx:*)",
  "Bash(PORT=8791 bun run local:*)",
  "Bash(curl:*)",
  "Bash(psql:*)",
  "Bash(supabase status:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(grep:*)",
  ...["status", "log", "diff", "show", "rev-parse"].map(
    (c) => `Bash(git ${c}:*)`,
  ),
].join(",");
// A FAIL for this reason names the other company in its ruling line.
const OTHER =
  /another company|other compan|cross-company|second company|cross-tenant|non-member/i;

export const crossCompany: Step = {
  does: "Runs the verifier agent (`claude -p --agent verifier` in a fresh scratch clone, with only Devesh's Claude login, its transcript saved in the report, holding the shared local stack as the gate's checks do) on a change that adds an API endpoint counting a company's open tasks, with its route and an API test for one company only, and checks that the verifier fails a change missing a cross-company test: its ruling is FAIL and its ruling line names the other company",
  minutes: 45,
  check: ({ root, env, file }) =>
    inScratch(root, ({ dir, base }) => {
      git(dir, "checkout", "-qb", "feat/open-task-count");
      for (const [path, text] of Object.entries(SAMPLE)) write(dir, path, text);
      write(
        dir,
        "packages/db/src/index.ts",
        `${git(dir, "show", "HEAD:packages/db/src/index.ts")}\nexport { openTaskCount } from "./open-tasks";\n`,
      );
      let routes = git(dir, "show", `HEAD:${ROUTES}`);
      for (const [from, to] of ROUTE_EDITS) {
        if (!routes.includes(from))
          throw new Error(
            `${ROUTES} no longer has \`${from.trim()}\`: update the sample in scripts/proof/slice-0-agents.ts`,
          );
        routes = routes.replace(from, to);
      }
      write(dir, ROUTES, `${routes}\n`);
      // The clone's own packages, its workspaces linked to its own code (a link to the proved checkout's would
      // check that code instead), from bun's cache; then the sample formatted as the gate's lint wants it.
      for (const cmd of [
        ["bun", "install", "--frozen-lockfile"],
        ["bunx", "biome", "check", "--write", ...Object.keys(SAMPLE), ROUTES],
        ["bunx", "biome", "check", "--write", "packages/db/src/index.ts"],
      ]) {
        const r = sh(dir, cmd);
        if (r.status !== 0)
          throw new Error(
            `\`${cmd.join(" ")}\` failed in the scratch clone: ${r.out.trim().split("\n").slice(-3).join(" / ")}`,
          );
      }
      commit(dir, "An API endpoint for a company's open-task count");
      // The verifier runs the whole gate and the tests on the one local database: it takes the proved checkout's
      // turn on it, as `bun run gate` does, since its scratch clone's own lock would not.
      return onSharedStack(
        root,
        () => {
          const report = conversation({
            dir,
            token: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
            path: env.PATH,
            home: join(base, "home"),
            transcript: file("verifier.txt"),
            events: file("verifier.jsonl"),
            tools: VERIFIER_TOOLS,
            args: ["--agent", "verifier"],
            dollars: 5,
          })(
            `Devesh's request, word for word: "${REQUEST}"\nWhat changed (branch feat/open-task-count, this checkout): packages/db/src/open-tasks.ts adds openTaskCount, exported from packages/db; ${ROUTES} adds GET /orgs/:orgId/tasks/open-count, which checks the caller is a member and returns { open: <count> }; services/worker/test/open-task-count-api.test.ts tests it through the API.\nHow it can be seen working: bun run local bun test services/worker/test/open-task-count-api.test.ts`,
          );
          const ruling = rulingOf(report);
          if (!ruling)
            throw new Error(
              `the verifier's report did not end with its ruling: ${short(report.trim().split("\n").at(-1), 200)}`,
            );
          if (ruling.verdict !== "fail" || !OTHER.test(ruling.note))
            throw new Error(
              `the verifier ruled ${ruling.verdict.toUpperCase()}${ruling.verdict === "fail" ? " without naming the other company in its ruling line" : ""}: ${ruling.note}`,
            );
          return `the verifier ruled FAIL: ${ruling.note}`;
        },
        timeLeft(),
      );
    }),
};

/** The two steps as Devesh's Mac runs them, by the names the record gives them. */
export const onMac: { [name in AiStep]: Step } = {
  "agent-session": agentSession,
  verifier: crossCompany,
};

/** `name`'s step as GitHub's proof run takes it: from the committed record, never a model. */
const fromRecord = (name: AiStep): Step => ({
  does: `${onMac[name].does}. It runs on Devesh's Mac (\`${MAC_COMMAND}\`, with his own Claude login); here it passes when the record committed in ${RECORD} passed it and every file it tests is as that run had it`,
  check: ({ root }) => {
    const { outcome, seen } = judgedAt(root, "HEAD", name);
    if (outcome === "waiting")
      throw new WaitingOn(
        `${AGAIN} (\`${MAC_COMMAND}\` in his own terminal, then a pull request commits what it writes): ${seen}`,
      );
    if (outcome === "failed") throw new Error(seen);
    return seen;
  },
});
export const agentSessionRecord = fromRecord("agent-session");
export const crossCompanyRecord = fromRecord("verifier");
