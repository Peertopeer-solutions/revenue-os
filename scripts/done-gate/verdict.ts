// Proven or not: the done rules, every check on this exact code, and for product code the verifier's ruling
// on it.

import { runChecks } from "./checks";
import { NOT_RUN, type NotRun, notRunWhy } from "./not-run";
import { isProduct, listed, rulesOn } from "./rules";
import type { Snap } from "./snapshot";
import type { Store } from "./store";

/** `notRun`: the checks on the database did not run, and why (not-run.ts). */
type Proof =
  | { ok: true; checks: string; notes: string[]; notRun?: NotRun }
  | { ok: false; headline: string; reason: string };
export type Ruling = {
  verdict: "pass" | "fail" | "cannot-verify";
  note: string;
};

const NEED_VERIFIER = `You can't finish yet: product code changed, and nobody independent has seen it work.
Run the verifier agent (Agent tool, subagent_type "verifier"), with no \`model\`: it runs on the one .claude/agents/verifier.md names. Give it Devesh's request word for word (when he typed none for this work, the message that started the session, or else the roadmap item's text, word for word; the gate also hands it his typed words, that message and the item's text itself), what you changed, and how you believe it can be seen working. Only its own delivered report counts: it ends with its ruling line. If it rules FAIL, fix what it found and run it again.
If you are stopping to ask Devesh a question rather than finishing, run \`bun run gate pause "<the question>"\` and stop again.`;

/**
 * Rules + checks: everything a machine can prove. Checks are cached per exact code; `cachedOnly` runs none.
 * `background`: work the session left running, so the checks on the database wait for a later stop.
 */
export async function prove(
  snap: Snap,
  store: Store,
  cachedOnly = false,
  background = false,
): Promise<Proof> {
  const { problems, notes } = rulesOn(snap);
  if (problems.length)
    return {
      ok: false,
      headline: `${problems.length} rule problem(s), first: ${problems[0]}`,
      reason: `You can't finish yet: your change breaks the done rules.\n${listed(problems)}`,
    };
  const checked = store.get("checked", snap.tree);
  if (checked) return { ok: true, checks: checked, notes };
  const notRun = notRunWhy(background);
  // Typecheck, lint and guards passed on it: without Docker (`partial`, which counts at merge once GitHub reports
  // `checks` passed), or while background work ran (`partial-background`, which never counts at merge: on a machine
  // with Docker the checks on the database must run here).
  const kind = notRun === "yet" ? "partial-background" : "partial";
  const partial = notRun && store.get(kind, snap.tree);
  if (partial) return { ok: true, checks: partial, notes, notRun };
  if (cachedOnly)
    return { ok: false, headline: "the checks have not passed", reason: "" };
  const r = await runChecks(snap.repo, !notRun);
  if (!r.ok)
    return {
      ok: false,
      headline: r.text.split("\n")[0] ?? "a check failed",
      reason: `You can't finish yet: ${r.text}\nFix the cause. Never skip, silence or weaken a check to get past it.`,
    };
  store.put(r.complete ? "checked" : kind, snap.tree, r.text); // a partial run never passes a full one
  return { ok: true, checks: r.text, notes, notRun };
}

/**
 * `codex`: the agent is Codex, which has no verifier agent, so it is never sent back to run one. `cachedOnly`: the
 * agent gave up on this code (prove). `background`: work the session left running. `verifying`: a verifier the agent
 * started in the background is still running, so its ruling is still to come.
 */
export async function judge(
  snap: Snap,
  store: Store,
  codex: boolean,
  { cachedOnly = false, background = false, verifying = false } = {},
): Promise<Verdict> {
  const proof = await prove(snap, store, cachedOnly, background);
  if (!proof.ok) return proof;
  return rule(
    snap.tree,
    proof,
    snap.files.some(isProduct),
    store,
    codex,
    verifying,
  );
}

/** `waits`: passed for now, but a later stop judges the same code again (database checks or a ruling to come). */
export type Verdict =
  | { ok: true; message: string; waits: boolean }
  | { ok: false; headline: string; reason: string };

const VERIFYING =
  "NOT verified yet: the verifier is still running, and the first stop after it ends reads its ruling";

/** Proven by machine; does the change also need, and have, the verifier's ruling on this exact code? */
function rule(
  tree: string,
  proof: { checks: string; notes: string[]; notRun?: NotRun },
  product: boolean,
  store: Store,
  codex: boolean,
  verifying: boolean,
): Verdict {
  const told = proof.notes.length ? ` · ⚠ ${proof.notes.join(" · ")}` : "";
  // When the checks on the database did not run, the line saying so leads in place of `all`, never a ✓, then `verifier`.
  const ok = (
    all: string,
    verifier?: string,
    waits = proof.notRun === "yet",
  ): Verdict => ({
    ok: true,
    message: `${proof.notRun ? [NOT_RUN[proof.notRun], verifier].filter(Boolean).join(" · ") : all}${told}`,
    waits,
  });
  if (!product)
    return ok(
      `Done gate ✓ ${proof.checks} (no product code changed, so no verifier needed)`,
    );
  const ruling = rulingOn(store, tree);
  const codexSays =
    "NOT independently verified (Codex has no verifier agent): ask Claude to run the verifier, or check it yourself";
  if (!ruling && codex)
    return ok(
      `Done gate ⚠ checks green (${proof.checks}), ${codexSays}`,
      codexSays,
    );
  // While a verifier it started in the background works, sending the agent back would only count toward its giving
  // up: it may stop, NOT verified, and a later stop judges the same code again.
  if (!ruling && verifying)
    return ok(
      `Done gate ⏳ ${VERIFYING} (checks green: ${proof.checks})`,
      VERIFYING,
      true,
    );
  if (!ruling)
    return {
      ok: false,
      headline: "product code changed and nobody independent has seen it work",
      reason: NEED_VERIFIER,
    };
  if (ruling.verdict === "cannot-verify") {
    const why = `NOT verified: the verifier needs something only you can provide: ${ruling.note}`;
    return ok(`Done gate ⚠ ${why} (checks green: ${proof.checks})`, why);
  }
  if (ruling.verdict === "fail")
    return {
      ok: false,
      headline: `the verifier ruled FAIL: ${ruling.note}`,
      reason: `You can't finish yet: the verifier ruled FAIL: ${ruling.note}\nFix what it found, then run the verifier again. It must rule on the code exactly as you leave it.`,
    };
  const pass = `verifier PASS: ${ruling.note}`;
  return ok(`Done gate ✓ ${proof.checks} · ${pass}`, pass);
}

/**
 * The record of delivered rulings, one per exact code; only verifier.ts writes it. Main's gate before 2026-10-03
 * kept rulings in `verdict`, from a command anyone could run, and a checkout on a branch cut before then still runs
 * that gate, so `verdict` is never read.
 */
export const DELIVERED = "delivered";

/** The verifier's delivered ruling on this exact code, if any. */
export function rulingOn(store: Store, tree: string): Ruling | undefined {
  try {
    const r = JSON.parse(store.get(DELIVERED, tree) ?? "") as Ruling;
    return ["pass", "fail", "cannot-verify"].includes(r.verdict) && r.note
      ? r
      : undefined;
  } catch {
    return undefined;
  }
}
