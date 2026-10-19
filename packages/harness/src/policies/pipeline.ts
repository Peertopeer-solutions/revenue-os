// The guard() pipeline: the checks in their order, and guard(), which runs them before every send and every tool's
// side effect; the first check that blocks decides.
// G1: runtime-agnostic.
import type { GuardedAction, OrgCtx, PolicyHook, Verdict } from "../types";
import { attemptCapHook } from "./attempt-cap";
import { autonomyHook } from "./autonomy";
import { quietHoursHook } from "./calling-hours";
import { dncHook } from "./do-not-call";

export const defaultPipeline: PolicyHook[] = [
  autonomyHook,
  dncHook,
  quietHoursHook,
  attemptCapHook,
];

export async function guard(
  ctx: OrgCtx,
  action: GuardedAction,
  pipeline: PolicyHook[] = defaultPipeline,
): Promise<Verdict> {
  for (const hook of pipeline) {
    const verdict = await hook(ctx, action);
    if (verdict && !verdict.ok) return verdict;
  }
  return { ok: true };
}
