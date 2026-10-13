// Whether this run of .github/workflows/staging-migrations.yml may and must apply migrations to the cloud test
// database (staging), told to the workflow as `apply=true` or `apply=false`. First it asks GitHub whether `checks`
// passed on the commit (SHA): an automatic run starts only after ci passed, but a skipped `checks` still lets ci
// pass, and a hand run starts on main's newest commit whatever ci said about it. Then it links the project and reads
// `supabase migration list`: the commit's migrations go in only when it changed a migration file or the cloud lacks
// one it has (an earlier run was missed or failed). Anything it can't read fails the run; nothing here ever skips by
// guessing.

import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";

const DIR = "supabase/migrations";
const NUMBERED = /^(\d+)_[^/]*\.sql$/; // the files `supabase db push` applies; the number is the version

function fail(why: string): never {
  console.error(`✗ ${why}`);
  process.exit(1);
}
/** A program's output; the run fails, naming it and quoting both its outputs (the CLI's JSON errors go to stdout), when it does. */
const out = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0)
    fail(
      `${cmd} ${args.slice(0, 2).join(" ")} failed: ${[r.stderr, r.stdout].join("").trim() || String(r.error ?? "")}`,
    );
  return r.stdout;
};
const said = (line: string) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

const {
  SHA: sha = "",
  GITHUB_REPOSITORY: repo = "",
  PROJECT_REF: ref = "",
  GITHUB_OUTPUT: output = "",
} = process.env;
if (
  !/^[0-9a-f]{40}$/.test(sha) ||
  !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
  !/^[a-z0-9]+$/.test(ref) ||
  !output
)
  fail(
    "needs SHA (the full commit id), GITHUB_REPOSITORY, PROJECT_REF and GITHUB_OUTPUT",
  );

// 1. `checks` passed on this exact commit, as GitHub Actions reported it last: anyone may post a check of that name,
// and main's copy of the rules lets only ci.yml's job `checks` report it from GitHub Actions (done-gate/pr.ts).
type CheckRun = {
  id: number;
  conclusion: string | null;
  app?: { slug?: string };
};
const [latest] = (
  JSON.parse(
    out("gh", [
      "api",
      `repos/${repo}/commits/${sha}/check-runs?check_name=checks&filter=latest`,
    ]),
  ) as {
    check_runs: CheckRun[];
  }
).check_runs
  .filter((c) => c.app?.slug === "github-actions")
  .sort((a, b) => b.id - a.id);
if (latest?.conclusion !== "success")
  fail(
    `\`checks\` has not passed on ${sha} (GitHub Actions' latest result: ${latest?.conclusion ?? "none"}), so its migrations may not reach the cloud test database`,
  );
said(`\`checks\` passed on ${sha} (check run ${latest?.id}).`);

// 2. What the commit changed, and what the cloud test database lacks.
const changed = out("git", [
  "diff",
  "-z",
  "--name-only",
  "--no-renames",
  `${sha}^`,
  sha,
  "--",
  `${DIR}/`,
])
  .split("\0")
  .filter((f) => NUMBERED.test(f.slice(DIR.length + 1)));
const local = readdirSync(DIR)
  .flatMap((f) => f.match(NUMBERED)?.[1] ?? [])
  .sort();
out("supabase", ["link", "--project-ref", ref]);
// Asked for as JSON: the CLI (2.109.1) prints JSON by itself only when it detects an AI agent (AI_AGENT,
// CLAUDECODE), and a table otherwise, as on GitHub's runner.
const listing = out("supabase", [
  "migration",
  "list",
  "--output-format",
  "json",
]);
const rows =
  (
    JSON.parse(listing.split("\n").find((l) => l.startsWith("{")) ?? "{}") as {
      migrations?: { local?: string; remote?: string }[];
    }
  ).migrations ?? [];
const listed = rows.flatMap((r) => r.local || []).sort();
const remote = rows.flatMap((r) => r.remote || []);
if (listed.join() !== local.join())
  fail(
    `supabase migration list lists local migrations ${listed.join(", ") || "none"}, but the checkout holds ${local.join(", ")}, so what the cloud lacks can't be told`,
  );
const ahead = remote.filter((v) => !local.includes(v));
if (ahead.length)
  fail(
    `the cloud test database has ${ahead.join(", ")}, which ${sha} doesn't: a newer commit's run applied it, or someone changed the database by hand; run this workflow on main's newest commit, and if that fails too, see what changed it`,
  );
const missing = local.filter((v) => !remote.includes(v));
const why = [
  changed.length && `it changed ${changed.join(", ")}`,
  missing.length && `the cloud test database lacks ${missing.join(", ")}`,
].filter(Boolean);
said(
  why.length
    ? `Applying: ${why.join(", and ")}.`
    : `Skipping: it changed no migration, and the cloud test database has all ${local.length}.`,
);
appendFileSync(output, `apply=${why.length > 0}\n`);
