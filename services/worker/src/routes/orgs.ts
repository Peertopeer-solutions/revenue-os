// Org bootstrap routes — docs/patterns/hono-route.md shape: validate → authorize → do → audit.
import {
  addMember,
  createOrgWithAdmin,
  isPlatformOperator,
  memberRole,
  updateOrg,
  userOrgs,
} from "@revenue-os/db";
import {
  AddMemberSchema,
  CreateOrgSchema,
  OrgIdSchema,
  UpdateOrgSchema,
} from "@revenue-os/shared";
import { Hono } from "hono";
import type { AuthEnv } from "../auth";
import { pool } from "../db";
import { jsonBody } from "../json-body";

export const orgs = new Hono<AuthEnv>()
  .post("/orgs", async (c) => {
    const actor = c.get("actor");
    // Only our operator list creates a company. Asked first, so a stranger learns nothing from a bad body (400) or a
    // taken slug (409).
    if (!(await isPlatformOperator(pool, actor.userId)))
      return c.json({ error: "not_an_operator" }, 403);
    const body = CreateOrgSchema.parse(await jsonBody(c)); // docs/security.md S5.1: before any other logic
    const org = await createOrgWithAdmin(pool, {
      ...body,
      userId: actor.userId,
    });
    return c.json({ id: org.id, role: "admin" }, 201); // docs/security.md S5.8 — no internals
  })
  .get("/orgs", async (c) => {
    const actor = c.get("actor");
    return c.json(await userOrgs(pool, actor.userId));
  })
  .patch("/orgs/:orgId", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const body = UpdateOrgSchema.parse(await jsonBody(c));
    const actor = c.get("actor");
    const callerRole = await memberRole(pool, orgId, actor.userId); // docs/security.md S1.7 — admin gate
    if (callerRole !== "admin") return c.json({ error: "forbidden" }, 403);
    const updated = await updateOrg(pool, orgId, body, actor.userId);
    return c.json({ id: orgId, name: updated.name });
  })
  .post("/orgs/:orgId/members", async (c) => {
    const orgId = OrgIdSchema.parse(c.req.param("orgId"));
    const body = AddMemberSchema.parse(await jsonBody(c));
    const actor = c.get("actor");
    const callerRole = await memberRole(pool, orgId, actor.userId); // docs/security.md S1.7 — admin gate
    if (callerRole !== "admin") return c.json({ error: "forbidden" }, 403);
    if (!(await addMember(pool, orgId, body, actor.userId)))
      return c.json({ error: "user_not_found" }, 404);
    return c.json({ ok: true }, 201);
  });
