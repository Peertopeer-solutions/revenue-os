// Slice 0's proof steps, in the order ROADMAP.md → Slice 0 → Proof gives them, one per check it names. Each runs
// against the local stack and scratch clones, branches and repositories it makes and removes: it never pushes, opens
// a pull request, touches the cloud or runs a refused command (the gate's hook is only handed it). The step for
// GitHub's run records only reads them. The two steps a model takes part in are taken from the record of their run
// on Devesh's Mac (slice-0-agents.ts).

import { agentSessionRecord, crossCompanyRecord } from "./slice-0-agents";
import {
  adminMerge,
  disallowedModel,
  interrupted,
  noDockerStop,
  selfPass,
  undeliveredRuling,
  unverifiedMerge,
  unverifiedStop,
  wrappedMerge,
} from "./slice-0-gate";
import { banner, lawFiles } from "./slice-0-plan";
import {
  barrelExport,
  deletedTest,
  editedMigration,
  fixWhenTouchedUnanswered,
  loosenedGate,
  noFirstLine,
  rewrittenCi,
  unexplainedRuleChange,
} from "./slice-0-rules";
import { runRecords } from "./slice-0-runs";
import {
  passesOnMain,
  patternFileGuard,
  twoRunsAtOnce,
  unrunLine,
} from "./slice-0-tests";
import { agentToolsRefused, hooksWarn } from "./slice-0-tools";
import type { Step } from "./step";

export const steps: Step[] = [
  lawFiles,
  banner,
  agentSessionRecord,
  hooksWarn,
  unexplainedRuleChange,
  loosenedGate,
  rewrittenCi,
  noFirstLine,
  fixWhenTouchedUnanswered,
  agentToolsRefused,
  runRecords,
  editedMigration,
  twoRunsAtOnce,
  patternFileGuard,
  unverifiedStop,
  unverifiedMerge,
  selfPass,
  undeliveredRuling,
  disallowedModel,
  wrappedMerge,
  adminMerge,
  noDockerStop,
  deletedTest,
  barrelExport,
  unrunLine,
  passesOnMain,
  crossCompanyRecord,
  interrupted,
];
