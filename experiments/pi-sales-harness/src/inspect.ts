// Prototype (experiments/pi-sales-harness/README.md). Prints what a lead's run would be given and what the
// guardrail boundary decides for each illustrative scenario: `bun experiments/pi-sales-harness/src/inspect.ts`.
// No model, credentials, database or network: it builds Pi's session options and calls the tools' handlers, as
// the model would through Pi, but never creates or prompts a session.
import { assembleLeadContext, renderContext } from "./context";
import { ROWS, SCENARIOS } from "./fixtures";
import { intentInputOf, placeholderIntent } from "./intent";
import {
  emptyOutbox,
  leadSessionOptions,
  proposeNextAction,
  rememberAboutLead,
} from "./session";
import { openScope } from "./tenancy";

const first = SCENARIOS[0];
if (!first) throw new Error("no scenarios");
const reader = openScope(ROWS, first.scope);
const options = leadSessionOptions(reader, emptyOutbox());
const loader = options.resourceLoader;
console.log(
  "Pi session options for one lead's run (src/session.ts leadSessionOptions)",
);
console.log(`  tools: ${options.tools?.join(", ")}`);
console.log(
  `  found on disk: ${loader?.getExtensions().extensions.length} extensions, ${loader?.getSkills().skills.length} skills, ${loader?.getAgentsFiles().agentsFiles.length} AGENTS.md files`,
);
console.log(
  `  history saved to disk: ${options.sessionManager?.isPersisted()}`,
);
console.log(
  `  compaction: ${JSON.stringify(options.settingsManager?.getCompactionSettings())}`,
);

console.log(
  "\nContext of the first scenario, by scope (src/context.ts assembleLeadContext)",
);
for (const s of assembleLeadContext(reader))
  console.log(
    `  ${s.scope.padEnd(7)} ${s.source.padEnd(19)} ${s.tokens} tokens, ${s.lines.length} lines, ${s.dropped} dropped · ${s.title}`,
  );
console.log(`\n${renderContext(assembleLeadContext(reader)).join("\n")}`);

for (const [i, s] of SCENARIOS.entries()) {
  const r = openScope(ROWS, s.scope);
  const intent = placeholderIntent(intentInputOf(r));
  const result = proposeNextAction(r, emptyOutbox(), s.proposal);
  console.log(`\n${i + 1}. ${s.title}`);
  console.log(
    `   scope from the host: ${s.scope.orgId} / ${s.scope.userId} / ${s.scope.leadId}`,
  );
  console.log(
    `   intent (placeholder, not a prediction): ${intent.label} · ${intent.signals.join("; ")}`,
  );
  const move = s.proposal.stage
    ? `, moving the lead to ${s.proposal.stage}`
    : "";
  console.log(`   proposal: ${s.proposal.kind} at ${s.proposal.at}${move}`);
  console.log(`   ${result.text.replaceAll("\n", "\n   ")}`);
}

console.log("\nIsolation (src/tenancy.ts openScope)");
for (const scope of [
  { orgId: "org-skyline", userId: "user-asha", leadId: "lead-kabir" },
  { orgId: "org-riverbend", userId: "user-asha", leadId: "lead-kabir" },
]) {
  try {
    openScope(ROWS, scope);
    console.log(`  opened ${JSON.stringify(scope)}: SHOULD NOT HAPPEN`);
  } catch (e) {
    console.log(`  ${JSON.stringify(scope)} refused: ${(e as Error).message}`);
  }
}

console.log("\nMemory writes (src/context.ts MEMORY_WRITES)");
const outbox = emptyOutbox();
console.log(
  `  ${rememberAboutLead(outbox, { kind: "preference", text: "Wants a Sunday visit with family" })}`,
);
console.log(
  `  ${rememberAboutLead(outbox, { kind: "fact", text: "Buyers keep asking if the metro extension is approved", companyWide: true })}`,
);
console.log(
  `  lead memories for the worker to write: ${outbox.leadMemories.length}; admin reviews: ${outbox.companyReviews.length}; company rules changed: 0`,
);
