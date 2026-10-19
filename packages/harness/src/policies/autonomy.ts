// The approval check: a tool whose autonomy is "forbidden" is blocked outright, and one whose autonomy is "approval"
// is turned into a human task by the loop (runTurn in loop.ts) instead of running.
// G1: runtime-agnostic.
import type { PolicyHook } from "../types";

/** Autonomy tiers: forbidden blocks outright; approval routes to a human task (runTurn in loop.ts). */
export const autonomyHook: PolicyHook = async (_ctx, action) => {
  if (action.autonomy === "forbidden")
    return { ok: false, reason: "forbidden" };
  if (action.autonomy === "approval")
    return { ok: false, reason: "approval_required" };
  return null;
};
