// A company's leads: the CSV import (how a company brings its own lead list, until any CRM sync), a person marking
// a lead do-not-call from the console, recording a lead's WhatsApp opt-in or its withdrawal, and setting which role
// works a lead — validate → authorize → do → audit.
import {
  importContacts,
  memberRole,
  type OptInSource,
  recordDoNotCall,
  recordWhatsAppOptIn,
  setAssignment,
  withdrawWhatsAppOptIn,
  withOrg,
} from "@revenue-os/db";
import {
  AssignmentInputSchema,
  ContactIdSchema,
  OrgIdSchema,
  parseCsv,
  WhatsAppOptInSchema,
} from "@revenue-os/shared";
import { type Context, Hono } from "hono";
import type { AuthEnv } from "../auth";
import { pool } from "../db";

/**
 * Records the lead's WhatsApp opt-in, or its withdrawal, with where they gave it: operator or admin only. A lead who
 * withdrew is refused a new opt-in (409): only their own written YES re-opts them (Slice 2).
 */
async function setOptIn(
  c: Context<AuthEnv>,
  write: typeof recordWhatsAppOptIn,
  optedIn: boolean,
) {
  const orgId = OrgIdSchema.parse(c.req.param("orgId"));
  const contactId = ContactIdSchema.parse(c.req.param("contactId"));
  const actor = c.get("actor");
  const role = await memberRole(pool, orgId, actor.userId);
  if (role !== "operator" && role !== "admin")
    return c.json({ error: "forbidden" }, 403);
  const body = WhatsAppOptInSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!body.success) return c.json({ error: "invalid_request" }, 400);
  const by: OptInSource = { source: body.data.source, userId: actor.userId };
  const said = await withOrg(pool, orgId, (tx) =>
    write(tx, orgId, contactId, by),
  );
  if (said === "not_found") return c.json({ error: "not_found" }, 404);
  if (optedIn && said === "withdrawn")
    return c.json({ error: "opt_in_withdrawn" }, 409);
  return c.json({ whatsapp_opt_in: optedIn });
}

const MAX_CSV_BYTES = 10 * 1024 * 1024; // a CSV is at most 10MB

export const contacts = new Hono<AuthEnv>()
  .post("/orgs/:orgId/contacts/import", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId); // changes need an operator or admin
    if (role !== "operator" && role !== "admin")
      return c.json({ error: "forbidden" }, 403);

    const raw = await c.req.text();
    if (raw.length > MAX_CSV_BYTES) return c.json({ error: "too_large" }, 413);

    const rows = parseCsv(raw);
    if (rows.length === 0 || !("phone" in (rows[0] ?? {}))) {
      return c.json({ error: "invalid_request" }, 400); // refused before any write
    }

    const summary = await importContacts(pool, orgId, rows, actor.userId);
    return c.json(summary); // counts only, never the leads
  })
  // Blocks every later message and call to the lead; nothing here lifts a block (only their written YES, Slice 2).
  .post("/orgs/:orgId/contacts/:contactId/do-not-call", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const contactId = ContactIdSchema.parse(c.req.param("contactId"));
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId);
    if (role !== "operator" && role !== "admin")
      return c.json({ error: "forbidden" }, 403);
    const said = await withOrg(pool, orgId, (tx) =>
      recordDoNotCall(tx, orgId, contactId, {
        from: "console",
        userId: actor.userId,
      }),
    );
    if (said === "not_found") return c.json({ error: "not_found" }, 404);
    return c.json({ do_not_call: true });
  })
  // Which role works the lead, and why: operator or admin only. A lead in a sequence is refused (409) unless the
  // assignment ends, since a lead is enrolled with a role or in a sequence, never both.
  .put("/orgs/:orgId/contacts/:contactId/assignment", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const contactId = ContactIdSchema.parse(c.req.param("contactId"));
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId);
    if (role !== "operator" && role !== "admin")
      return c.json({ error: "forbidden" }, 403);
    const body = AssignmentInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const set = await withOrg(pool, orgId, (tx) =>
      setAssignment(tx, orgId, contactId, {
        ...body.data,
        actor: { type: "user", id: actor.userId },
      }),
    );
    if (set.ok) return c.json({ assignment: set.assignment });
    if (set.refused === "not_found") return c.json({ error: "not_found" }, 404);
    if (set.refused === "unknown_role")
      return c.json({ error: "unknown_role" }, 422);
    return c.json({ error: "lead_in_sequence", run_id: set.runId }, 409);
  })
  .post("/orgs/:orgId/contacts/:contactId/whatsapp-opt-in", (c) =>
    setOptIn(c, recordWhatsAppOptIn, true),
  )
  .post("/orgs/:orgId/contacts/:contactId/whatsapp-opt-out", (c) =>
    setOptIn(c, withdrawWhatsAppOptIn, false),
  );
