// Org bootstrap + membership helpers — the only sanctioned queries for these flows (AGENTS.md: DB
// access only via packages/db).
// G1: runtime-agnostic.
import type {
  AddMember,
  CreateOrg,
  OrgRole,
  UpdateOrg,
} from "@revenue-os/shared";
import type pg from "pg";
import { audit } from "./audit";
import { withOrg } from "./client";

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

/** Create an org and its first admin membership in one org-scoped transaction. */
export async function createOrgWithAdmin(
  pool: pg.Pool,
  input: CreateOrg & { userId: string },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await withOrg(pool, id, async (tx) => {
    await tx.query(
      `insert into orgs (id, name, slug, vertical) values ($1, $2, $3, $4)`,
      [id, input.name, input.slug, input.vertical],
    );
    await tx.query(
      `insert into org_members (org_id, user_id, role) values ($1, $2, 'admin')`,
      [id, input.userId],
    );
    await audit(tx, id, {
      actorType: "user",
      actorId: input.userId,
      action: "org.create",
      resourceType: "org",
      resourceId: id,
      after: { name: input.name, slug: input.slug, vertical: input.vertical },
    });
  });
  return { id };
}

/** Sample audited mutation: rename an org — before/after captured atomically. */
export async function updateOrg(
  pool: pg.Pool,
  orgId: string,
  patch: UpdateOrg,
  actorUserId: string,
): Promise<{ name: string }> {
  return withOrg(pool, orgId, async (tx) => {
    const before = await tx.query(
      `select name from orgs where id = $1 for update`,
      [orgId],
    );
    if (before.rows.length === 0) throw new Error("org not found");
    const after = await tx.query(
      `update orgs set name = $2, updated_at = now() where id = $1 returning name`,
      [orgId, patch.name],
    );
    await audit(tx, orgId, {
      actorType: "user",
      actorId: actorUserId,
      action: "org.update",
      resourceType: "org",
      resourceId: orgId,
      before: { name: before.rows[0].name },
      after: { name: after.rows[0].name },
    });
    return { name: after.rows[0].name };
  });
}

/**
 * The caller's effective role in an org, honoring support-access expiry (docs/db-design.md
 * section 14.1).
 */
export async function memberRole(
  pool: pg.Pool,
  orgId: string,
  userId: string,
): Promise<OrgRole | null> {
  return withOrg(pool, orgId, async (tx) => {
    const r = await tx.query(
      `select role from org_members
			 where org_id = $1 and user_id = $2 and (expires_at is null or expires_at > now())`,
      [orgId, userId],
    );
    return (r.rows[0]?.role as OrgRole) ?? null;
  });
}

/** Adds `member` to the company: false, with nothing written, when member.userId names no one (no profiles row). */
export async function addMember(
  pool: pg.Pool,
  orgId: string,
  member: AddMember,
): Promise<boolean> {
  try {
    await withOrg(pool, orgId, async (tx) => {
      await tx.query(
        `insert into org_members (org_id, user_id, role) values ($1, $2, $3)`,
        [orgId, member.userId, member.role],
      );
    });
    return true;
  } catch (err) {
    // Only this foreign key is the caller's mistake; any other failure, another foreign key included, is a fault.
    if ((err as pg.DatabaseError).constraint === "org_members_user_id_fkey")
      return false;
    throw err;
  }
}

/** Is `userId` on our operator list, the only people who may create a company? Asked before any company exists,
 *  so through the app.is_platform_operator SECURITY DEFINER function, granted to app_service only (migration 018).
 *  userId MUST be a jose-verified JWT sub. */
export async function isPlatformOperator(
  pool: pg.Pool,
  userId: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId))
    return false;
  const r = await pool.query<{ ok: boolean }>(
    `select app.is_platform_operator($1) as ok`,
    [userId],
  );
  return r.rows[0]?.ok === true;
}

/** Cross-org by nature (login → org switcher): served by the app.user_orgs SECURITY DEFINER
 *  function, granted to app_service only. userId MUST be a jose-verified JWT sub. Ordered by name
 *  (then id) so "the first workspace" the console's / landing opens is a defined rule. */
export async function userOrgs(
  pool: pg.Pool,
  userId: string,
): Promise<OrgRow[]> {
  const r = await pool.query(
    `select org_id as id, name, slug, role from app.user_orgs($1) order by name, org_id`,
    [userId],
  );
  return r.rows as OrgRow[];
}
