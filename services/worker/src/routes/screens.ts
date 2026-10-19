// Console screens read path (task 15, spec §12 E) — docs/patterns/hono-route.md shape:
// validate → authorize → do. Four org-scoped read endpoints backing task queue, contacts,
// live monitor, and dashboard.
import {
  funnelMetrics,
  funnelTrends,
  listContacts,
  listConversations,
  listTasks,
  memberRole,
} from "@revenue-os/db";
import { ContactSearchSchema, OrgIdSchema } from "@revenue-os/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../auth";
import { pool } from "../db";

export const screens = new Hono<AuthEnv>()
  .get("/orgs/:orgId/tasks", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId")); // S5.1 — before ANY logic
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId);
    if (role === null) return c.json({ error: "forbidden" }, 403);
    const tasks = await listTasks(pool, orgId);
    return c.json({ tasks }); // S5.8 — no internals
  })
  .get("/orgs/:orgId/contacts", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const search = ContactSearchSchema.parse(c.req.query("q"));
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId);
    if (role === null) return c.json({ error: "forbidden" }, 403);
    const contacts = await listContacts(pool, orgId, search);
    return c.json({ contacts });
  })
  .get("/orgs/:orgId/conversations", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId);
    if (role === null) return c.json({ error: "forbidden" }, 403);
    const conversations = await listConversations(pool, orgId);
    return c.json({ conversations });
  })
  .get("/orgs/:orgId/metrics", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId);
    if (role === null) return c.json({ error: "forbidden" }, 403);
    const metrics = await funnelMetrics(pool, orgId);
    return c.json({ metrics });
  })
  .get("/orgs/:orgId/metrics/trends", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId")); // S5.1 — before ANY logic
    const actor = c.get("actor");
    const role = await memberRole(pool, orgId, actor.userId);
    if (role === null) return c.json({ error: "forbidden" }, 403);
    const trends = await funnelTrends(pool, orgId);
    return c.json({ trends }); // S5.8 — no internals
  });
