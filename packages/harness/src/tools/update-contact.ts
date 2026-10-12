// The AI's update_contact tool. Updates only the provided fields of one of the company's own leads
// through ctx.db (the RLS-scoped door), filtered by company too: an absent field is sent as null
// and coalesce keeps the lead's current value, so it is never touched. An update that matches no
// lead (a wrong id, or another company's lead) reports contact_not_found, so the model sees the
// failure next round. Spec: packages/harness/test/tools.test.ts. G1: runtime-agnostic.
import { z } from "zod";
import type { Tool } from "../types";

// z.guid() over z.uuid() for the same reason as book_appointment. .refine() requires at least
// one field so an empty update can't reach execute (arguments are validated before anything
// runs); .strict() rejects unknown keys.
const schema = z
  .object({
    contactId: z.guid(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.firstName !== undefined || v.lastName !== undefined, {
    message: "provide at least one of firstName, lastName",
  });

export const updateContact: Tool<z.infer<typeof schema>> = {
  name: "update_contact",
  description: "Update a contact's named fields.",
  schema,
  autonomy: "auto",
  async execute(ctx, args) {
    const r = await ctx.db.query(
      `update contacts set first_name = coalesce($3, first_name), last_name = coalesce($4, last_name)
       where id = $1 and org_id = $2`,
      [
        args.contactId,
        ctx.orgId,
        args.firstName ?? null,
        args.lastName ?? null,
      ],
    );
    // A zero-row update is no database error: the turn carries on and records the failure.
    return (r.rowCount ?? 0) > 0
      ? { ok: true, data: null }
      : { ok: false, error: "contact_not_found" };
  },
};
