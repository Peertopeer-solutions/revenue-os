// Vapi webhook receiver — S6 doctrine: verify secret on the RAW body first, Zod-parse,
// insert webhook_events with a dedupe key, return 202 fast. Side effects live in the
// processor (vapi/process.ts), never here (S6.4).
// Org resolution: the per-assistant server URL carries the org id (interim mechanism —
// the Vapi spike decides the final assistant-id mapping; see lessons.md).

import { createHash, timingSafeEqual } from "node:crypto";
import { withOrg } from "@revenue-os/db";
import { OrgIdSchema, VapiWebhookSchema } from "@revenue-os/shared";
import { Hono } from "hono";
import { pool } from "../db";
import { enqueueVapiProcess } from "../jobs";

function secretMatches(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (!candidate) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export const vapiWebhook = new Hono().post(
  "/webhooks/vapi/:orgId",
  async (c) => {
    const expected = process.env.VAPI_WEBHOOK_SECRET;
    if (!expected) return c.json({ error: "not_configured" }, 501);

    const raw = await c.req.text(); // RAW body before any parsing (S6.2)
    if (!secretMatches(c.req.header("x-vapi-secret"), expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    let payload: unknown;
    try {
      payload = JSON.parse(raw); // malformed body = clean 400, never a logged 500 (S5.8)
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const parsed = VapiWebhookSchema.safeParse(payload);
    if (!parsed.success) return c.json({ error: "invalid_payload" }, 400);

    const m = parsed.data.message;
    const dedupeKey = `vapi:${m.id ?? `${m.call?.id ?? "nocall"}:${m.type}:${m.timestamp ?? ""}`}`;

    await withOrg(pool, orgId, async (tx) => {
      await tx.query(
        `insert into webhook_events (org_id, provider, event_type, dedupe_key, payload)
			 values ($1, 'vapi', $2, $3, $4)
			 on conflict (org_id, provider, dedupe_key) do nothing`,
        [orgId, m.type, dedupeKey, raw],
      );
    });

    // after the insert commits: nudge the consumer (still S6.4 — the side effects live
    // in the processor; losing this nudge is safe, see jobs.ts)
    await enqueueVapiProcess(orgId);

    return c.body(null, 202); // fast, information-free
  },
);
