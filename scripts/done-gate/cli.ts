// `bun run gate` and `bun run see` from a terminal: every check, the rules alone, the tests, a pause, the branch's
// checkpoint, or what a signed-in person sees. The verifier's ruling is not among them: only its own delivered
// report counts (verifier.ts).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breakCheck } from "./break-check";
import { toplevel } from "./checkouts";
import { checkpointCommand } from "./checkpoint";
import { browserEnv, run, tail } from "./checks";
import { git } from "./git";
import { NOT_RUN } from "./not-run";
import { judgePr } from "./pr";
import { listed, rulesOn } from "./rules";
import { onSharedStack } from "./shared-stack";
import { snapshot } from "./snapshot";
import { Store, stateDir } from "./store";
import { testsProven } from "./tests-proven";
import { allTestsRun, LEAVE_AT_ONCE } from "./tests-ran";
import { prove, rulingOn } from "./verdict";

const USAGE = `usage: bun run gate [rules [--base <ref>] [--head <ref>] | pr [--base <ref>] [--head <ref>] | tests [e2e | --leave-at-once-to-ci] | pause "<question>" | checkpoint [--done "<…>" --failed "<…>" --next "<…>"]]
       bun run see <console path> [more paths]   (":org" in a path becomes the seeded workspace)
       pr reads the pull request's body from PR_BODY and its number from PR_NUMBER; --head judges a commit as data
       bun run gate proven [--base <ref>]   the change's new and edited tests fail on main's code and pass on it
       bun run gate broken [--base <ref>]   each new line of guardrail, tenancy and money code, broken on purpose, makes a test fail`;

/**
 * PURE: a message holding text the pull request supplied (a file's name, its body's first line) as one log line:
 * each control character is written as its code, so a newline or carriage return can't start a line of its own,
 * which GitHub's runner would read as a command such as `::error`.
 */
const oneLine = (s: string) =>
  s.replace(
    /\p{Cc}/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** `--base <ref>` and `--head <ref>`, each at most once, and nothing else; undefined for any other words. */
const refsOf = (args: string[]) => {
  const refs = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [flag = "", ref = ""] = [args[i], args[i + 1]];
    if (
      !["--base", "--head"].includes(flag) ||
      !ref ||
      ref.startsWith("-") ||
      refs.has(flag)
    )
      return;
    refs.set(flag, ref);
  }
  return {
    base: refs.get("--base") ?? "origin/main",
    head: refs.get("--head"),
  };
};

/** The change from `base` to `head` (the worktree without one), or exit 2 saying why `who` can't read it. */
const changeOf = (who: string, repo: string, base: string, head?: string) => {
  try {
    return snapshot(repo, true, base, head);
  } catch (e) {
    console.error(
      `${who} ✗ could not compare ${head ?? "the change"} with ${base}: ${String(e).split("\n")[0]}`,
    );
    process.exit(2);
  }
};

export async function cli(cmd: string, args: string[]) {
  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const store = new Store(stateDir(repo));
  const text = args.join(" ").trim();
  const refs = refsOf(args);
  if (cmd === "check") {
    const snap = snapshot(repo);
    const proof = await prove(snap, store);
    const ruling = rulingOn(store, snap.tree);
    console.log(
      proof.ok
        ? `${proof.notRun ? `${NOT_RUN[proof.notRun]} · passed here: ` : "Done gate ✓ "}${proof.checks}${proof.notes.map((n) => `\n⚠ ${n}`).join("")}`
        : `Done gate ✗ ${proof.reason}`,
    );
    console.log(
      ruling
        ? `Verifier on this exact code: ${ruling.verdict.toUpperCase()}: ${ruling.note}`
        : "Verifier: no ruling on this exact code yet.",
    );
    process.exit(proof.ok ? 0 : 1);
  } else if (cmd === "rules" && refs) {
    const { base, head } = refs;
    const { problems, notes } = rulesOn(
      changeOf("Done rules", repo, base, head),
    );
    const what = `the change${head ? ` in ${head}` : ""} since ${base}`;
    console.log(
      (problems.length
        ? `Done rules ✗ ${problems.length} problem(s) in ${what}:\n${listed(problems)}`
        : `Done rules ✓ nothing in ${what} breaks them`) +
        notes.map((n) => `\n⚠ ${n}`).join(""),
    );
    process.exit(problems.length ? 1 : 0);
  } else if (cmd === "pr" && refs) {
    const { base, head } = refs;
    const body = process.env.PR_BODY;
    const pr = process.env.PR_NUMBER?.trim() || undefined;
    if (body === undefined || (pr && !/^\d+$/.test(pr))) {
      console.error(
        'Pull request ✗ give its body in PR_BODY (PR_BODY="$(cat body.md)") and, when it has one, its number in PR_NUMBER',
      );
      process.exit(2);
    }
    const { problems, notes } = await judgePr(
      changeOf("Pull request", repo, base, head),
      body,
      pr,
      base,
    );
    const what = `the change${head ? ` in ${head}` : ""} since ${base}`;
    console.log(
      (problems.length
        ? `Pull request ✗ ${problems.length} problem(s) in ${what}:\n${problems.map((p) => `- ${oneLine(p)}`).join("\n")}`
        : `Pull request ✓ its first line names what it is, nothing in ${what} breaks the done rules, every rule change is explained and recorded, and every fix-when-touched entry it touches is answered`) +
        notes.map((n) => `\n⚠ ${oneLine(n)}`).join(""),
    );
    process.exit(problems.length ? 1 : 0);
  } else if (
    cmd === "tests" &&
    args.length <= 1 &&
    [undefined, "e2e", LEAVE_AT_ONCE].includes(args[0])
  ) {
    process.exit(
      allTestsRun(repo, args[0] === "e2e", args[0] === LEAVE_AT_ONCE),
    );
  } else if (cmd === "proven" && refs && !refs.head) {
    // Lines the change only moved are left out as the snapshot marks them (moved.ts, read in test-edits.ts).
    const r = testsProven(repo, changeOf("Tests proven", repo, refs.base));
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "broken" && refs && !refs.head) {
    const r = breakCheck(repo, changeOf("Break check", repo, refs.base));
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "checkpoint") {
    process.exit(checkpointCommand(toplevel(repo), store, args));
  } else if (cmd === "pause" && text) {
    store.put("pause", snapshot(repo, false).tree, text);
    console.log(
      "Paused. Your next stop reaches Devesh as a question, with the change marked NOT verified.",
    );
  } else if (cmd === "see" && text) {
    const out = mkdtempSync(join(tmpdir(), "revenue-os-see-"));
    const r = await onSharedStack(repo, async () =>
      run(repo, ["bun", "run", "local", "bun", "run", "e2e", "see.e2e.ts"], {
        ...(await browserEnv()),
        SEE_PATHS: text,
        SEE_OUT: out,
      }),
    ).catch((e: Error) => ({ status: 1, out: e.message }));
    console.log(tail(r.out, 30));
    console.log(
      r.status === 0
        ? `\nSaved in ${out}: per path, a .png (the page) and a .txt (URL, visible text, every error).`
        : "\nsee failed; the output above says why.",
    );
    process.exit(r.status);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
}
