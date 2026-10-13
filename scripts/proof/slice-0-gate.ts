// Slice 0's proof: what the done gate refuses at a stop and at a merge, driven in a clone of the proved commit as an
// agent's session drives it (its hook's inputs on stdin, a stand-in GitHub for the pull request). The checks a
// passing `bun run gate` would run are recorded as passed rather than run (in a clone they would take minutes), so
// each refusal is the one under test. The verifier's runs are the inputs Claude Code gives the hook, as the gate's
// own tests record them (scripts/done-gate-verifier-run.ts).

import { chmodSync, constants, copyFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "../done-gate/snapshot";
import { removeTranscripts, verifierRun } from "../done-gate-verifier-run";
import {
  bash,
  checksPassed,
  hook,
  said,
  standInGitHub,
  type Told,
} from "./gate";
import { namedTestsPass } from "./named-tests";
import { commit, git, inScratch, plainEnv, sh, write } from "./scratch";
import type { Step } from "./step";
import { timeLeft } from "./time-limit";

const PRODUCT = "services/worker/src/proof-sample.ts";
const NOTE = "docs/proof-sample.md";
const SESSION = "proof-1";
const PASS = "Ruling: PASS — saw the sample work";
const gateIn = (dir: string) => join(dir, "scripts", "done-gate.ts");
const first = (s: string) => s.split("\n")[0] ?? "";

/** In `dir`: a session notes the checkout, then makes a product change whose checks pass and that nobody verified. */
function unverified(dir: string) {
  hook(dir, "SessionStart");
  write(
    dir,
    PRODUCT,
    "// a sample the proof makes and throws away\nconst sample = 1;\n",
  );
  checksPassed(dir);
}

/** The stop that follows: sent back to run the verifier, or an error saying what it did instead. */
function heldForVerifier(dir: string, when: string): Told {
  const s = hook(dir, "Stop");
  if (!s.sentBack || !s.why.includes("verifier"))
    throw new Error(
      `${when}, the stop was not sent back for the verifier: ${said(s)}`,
    );
  return s;
}

/**
 * The unverified change committed on a branch whose checks passed, and a stand-in GitHub naming it pull request 7's
 * head, `checks` passed on it and main's tip in it.
 */
function pullRequest(dir: string, base: string) {
  git(dir, "checkout", "-qb", "feat/proof-sample");
  unverified(dir);
  const head = commit(dir, "a sample product change");
  return { head, env: standInGitHub(dir, join(base, "gh-bin"), head).env };
}
const merge = (head: string, extra = "") =>
  `gh pr merge 7 --squash${extra} --match-head-commit ${head}`;

/**
 * A verifier run the gate sees, cleaned up after; `run` as scripts/done-gate-verifier-run.ts takes it. Its hook
 * calls get the PATH and home folder only, and stop when the step's time is up.
 */
function verifier(dir: string, run: Parameters<typeof verifierRun>[2]) {
  try {
    return verifierRun(gateIn(dir), dir, {
      session: SESSION,
      env: plainEnv(),
      timeout: timeLeft(),
      ...run,
    });
  } finally {
    removeTranscripts();
  }
}

export const unverifiedStop: Step = {
  does: "Makes a deliberately unverified change (product code whose checks passed, with no verifier ruling) and checks that the done gate refuses its stop",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      unverified(dir);
      return `the stop was sent back: ${first(heldForVerifier(dir, "With no ruling").why)}`;
    }),
};

// The tests the Proof line cites as also proving the merge's refusal, by name.
const MERGE_TESTS = [
  "refuses an agent's merge until the pull request's head commit passed the gate and, for product code, the verifier",
  "refuses a merge the verifier could not verify: only Devesh merges it",
];

export const unverifiedMerge: Step = {
  does: `Commits that unverified change on a branch and checks that the done gate refuses its merge (\`gh pr merge 7 --squash --match-head-commit <its commit>\`, against a stand-in gh); then runs, by name, the two tests in scripts/done-gate.test.ts the Proof line cites as also proving it ("${MERGE_TESTS.join('" and "')}"), each of which must pass`,
  check: async ({ root }) => {
    const refusal = await inScratch(root, ({ dir, base }) => {
      const { head, env } = pullRequest(dir, base);
      const m = hook(dir, "PreToolUse", bash(merge(head)), { env });
      if (!m.refused || !/verif|independent/.test(m.why))
        throw new Error(
          `the merge was not refused for want of the verifier: ${said(m)}`,
        );
      return `refused: ${said(m)}`;
    });
    return `${refusal}; ${namedTestsPass(root, "scripts/done-gate.test.ts", MERGE_TESTS)}`;
  },
};

export const selfPass: Step = {
  does: "Tries a PASS the building agent records for itself on that unverified change (`bun run gate verdict pass`, and writing a PASS into the gate's record), and checks that both are refused and its stop still is",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      unverified(dir);
      const typed = sh(dir, [
        "bun",
        "scripts/done-gate.ts",
        "verdict",
        "pass",
        "looks fine to me",
      ]);
      if (typed.status === 0)
        throw new Error(
          `\`bun run gate verdict pass\` was accepted: ${first(typed.out)}`,
        );
      const tree = snapshot(dir, false).tree;
      const forged = hook(
        dir,
        "PreToolUse",
        bash(
          `echo '{"verdict":"pass","note":"looks fine to me"}' > .git/done-gate/delivered/${tree}`,
        ),
      );
      if (!forged.refused)
        throw new Error(
          "writing a PASS into the gate's record was let through",
        );
      heldForVerifier(dir, "After both");
      return `\`bun run gate verdict pass\` is no command (exit ${typed.status}); writing a PASS into the record was refused (${said(forged)}); the stop was still sent back for the verifier`;
    }),
};

export const undeliveredRuling: Step = {
  does: "Gives the gate a PASS the verifier did not deliver (a verifier in auto mode that stops without handing its report back, and one a workflow script started) and checks that neither counts: the stop is still refused",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      unverified(dir);
      verifier(dir, { report: PASS, handsBack: false });
      heldForVerifier(dir, "After a PASS never handed back");
      const script = verifier(dir, {
        report: PASS,
        byWorkflow: true,
        auto: false,
      });
      const told = String(script.stops.at(-1)?.out.systemMessage ?? "");
      if (!told.includes("does not count"))
        throw new Error(
          `a workflow script's verifier was not told apart: ${told || "(nothing said)"}`,
        );
      heldForVerifier(dir, "After a workflow script's verifier");
      return `neither counted; Devesh was told "${told}" and the stop was still sent back`;
    }),
};

export const disallowedModel: Step = {
  does: "Starts the verifier on a model not on the allowed list (an Agent call naming `claude-haiku-4-5`, and a run whose replies came from it) and checks that the call is refused and the run's PASS does not count",
  check: ({ root }) =>
    inScratch(root, ({ dir }) => {
      unverified(dir);
      const model = "claude-haiku-4-5";
      const call = verifier(dir, { report: PASS, model }).call?.out;
      if (call?.hookSpecificOutput?.permissionDecision !== "deny")
        throw new Error(
          `an Agent call for the verifier on ${model} was let through`,
        );
      const ran = verifier(dir, { report: PASS, models: [model] });
      const told = String(ran.stops.at(-1)?.out.systemMessage ?? "");
      heldForVerifier(dir, `After a verifier that ran on ${model}`);
      return `the call was refused (${call.systemMessage ?? call.hookSpecificOutput?.permissionDecisionReason}); the run's PASS did not count (${told || "nothing recorded"})`;
    }),
};

/** Pull request 7, its head proven: checks passed and the verifier's own PASS, so a plain merge goes through. */
function proven(dir: string, base: string) {
  const pr = pullRequest(dir, base);
  verifier(dir, { report: PASS });
  const plain = hook(dir, "PreToolUse", bash(merge(pr.head)), { env: pr.env });
  if (plain.refused)
    throw new Error(
      `even the plain merge of a proven head was refused, so this shows nothing: ${said(plain)}`,
    );
  return pr;
}

export const wrappedMerge: Step = {
  does: "Proves a pull request's head (checks passed, the verifier's PASS) so its plain merge goes through, then checks that the done gate refuses the same merge wrapped in another command (`sh -c`, `bash -c`, `eval`, `xargs`)",
  check: ({ root }) =>
    inScratch(root, ({ dir, base }) => {
      const { head, env } = proven(dir, base);
      const wrapped = [
        `sh -c '${merge(head)}'`,
        `bash -c "${merge(head)}"`,
        `eval "${merge(head)}"`,
        `echo 7 | xargs gh pr merge --squash --match-head-commit ${head}`,
      ];
      const through = wrapped.filter(
        (c) => !hook(dir, "PreToolUse", bash(c), { env }).refused,
      );
      if (through.length) throw new Error(`let through: ${through.join("; ")}`);
      return `the plain merge went through; all ${wrapped.length} wrapped ones were refused, as \`${wrapped[0]}\`: ${said(hook(dir, "PreToolUse", bash(wrapped[0] ?? ""), { env }))}`;
    }),
};

export const adminMerge: Step = {
  does: "Proves a pull request's head so its plain merge goes through, then checks that the done gate refuses the same merge with `--admin`",
  check: ({ root }) =>
    inScratch(root, ({ dir, base }) => {
      const { head, env } = proven(dir, base);
      const m = hook(dir, "PreToolUse", bash(merge(head, " --admin")), { env });
      if (!m.refused)
        throw new Error(`\`${merge(head, " --admin")}\` was let through`);
      return `the plain merge went through; with --admin it was refused: ${said(m)}`;
    }),
};

export const noDockerStop: Step = {
  does: "Stops after a change on a machine without Docker (a `docker` that can't run comes first on the PATH; typecheck, lint and guards recorded as passed, the database checks not run) and checks that the stop is shown as NOT fully checked, never with a ✓",
  check: ({ root }) =>
    inScratch(root, ({ dir, base }) => {
      hook(dir, "SessionStart");
      write(dir, NOTE, "a sample the proof makes and throws away\n");
      checksPassed(dir, "partial");
      // bun beside the stand-in, so the gate, which puts bun's folder first on its PATH, still finds the stand-in first.
      const bin = join(base, "no-docker");
      write(bin, "docker", "#!/bin/sh\nexit 127\n");
      chmodSync(join(bin, "docker"), 0o755);
      const bun = join(bin, "bun");
      try {
        linkSync(process.execPath, bun);
      } catch {
        copyFileSync(process.execPath, bun, constants.COPYFILE_FICLONE);
        chmodSync(bun, 0o755);
      }
      const s = hook(
        dir,
        "Stop",
        {},
        { env: { PATH: `${bin}:${process.env.PATH}` }, bun },
      );
      if (!s.told.includes("NOT fully checked") || s.told.includes("✓"))
        throw new Error(
          `the stop said: ${s.sentBack ? `sent back: ${first(s.why)}` : said(s)}`,
        );
      return `the stop said: ${s.told}`;
    }),
};

// How long before the new session the interrupted one last worked: an agent's worktree is left alone while another
// session that worked there is at work, and the gate counts a session quiet for 15 minutes as stopped.
const AN_HOUR_AGO = 60;

export const interrupted: Step = {
  does: "Starts a session after an interrupted, unchecked change on a branch (in a worktree of its own, where the session before saved a checkpoint with `bun run gate checkpoint` an hour earlier and never stopped), and checks that the new session is shown its checkpoint and held at the done gate until that change passes",
  check: ({ root }) =>
    inScratch(root, ({ dir, base }) => {
      const wt = join(base, "worktree");
      git(dir, "worktree", "add", "-q", "-b", "feat/proof-interrupted", wt);
      // The session before ran an hour ago: its gate calls run on a clock set back that far.
      const past = join(base, "an-hour-ago.ts");
      write(
        base,
        "an-hour-ago.ts",
        `const now = Date.now;\nDate.now = () => now() - ${AN_HOUR_AGO * 60_000};\n`,
      );
      const earlier = ["--preload", past];
      const one = { session: "proof-1", args: earlier };
      const two = { session: "proof-2" };
      hook(wt, "SessionStart", {}, one);
      hook(wt, "PreToolUse", bash("git status"), one);
      write(wt, NOTE, "a sample the proof makes and throws away\n");
      const next = "run bun run gate on the sample note";
      const parts = [
        "--done",
        "wrote the sample note",
        "--failed",
        "nothing yet",
        "--next",
        next,
      ];
      const asked = hook(
        wt,
        "PreToolUse",
        bash(
          `bun run gate checkpoint ${parts.map((p) => (p.startsWith("--") ? p : `"${p}"`)).join(" ")}`,
        ),
        one,
      );
      if (asked.refused)
        throw new Error(
          `\`bun run gate checkpoint\` was refused: ${said(asked)}`,
        );
      const saved = sh(wt, [
        "bun",
        ...earlier,
        "scripts/done-gate.ts",
        "checkpoint",
        ...parts,
      ]);
      if (saved.status !== 0)
        throw new Error(
          `\`bun run gate checkpoint\` saved no checkpoint (exit ${saved.status}): ${first(saved.out)}`,
        );
      const start = hook(wt, "SessionStart", {}, two);
      if (!start.context.includes(next))
        throw new Error(
          `the new session was not shown the checkpoint: ${start.context || said(start)}`,
        );
      if (!/held/.test(start.told))
        throw new Error(
          `Devesh was not told the new session is held: ${said(start)}`,
        );
      const held = hook(wt, "Stop", {}, two);
      if (!held.sentBack)
        throw new Error(
          `its stop, with the change unchecked, was let through: ${said(held)}`,
        );
      checksPassed(wt);
      const passed = hook(wt, "Stop", {}, two);
      if (passed.sentBack)
        throw new Error(
          `once the change passed, its stop was still sent back: ${first(passed.why)}`,
        );
      return `the new session was shown its checkpoint and held (${start.told}); its stop was sent back (${first(held.why)}) until the change passed, then let through (${said(passed)})`;
    }),
};
