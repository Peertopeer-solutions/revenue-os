// book_appointment: books an appointment of the kind the role books and records the outcome a booking records, both
// read from the role version's rules (`booking`, packages/shared/src/role.ts), so the appointment's kind and the
// outcome's name are rows of the role, never words in the engine. A role whose rules name no booking is refused before
// anything is written. Two writes on the caller's transaction (ctx.db): the appointment, returning its id, then its
// attributed outcome (source 'agent', that appointment, conversation_id = ctx.conversationId, which traces to the run
// through conversations.workflow_run_id) on the same handle. Errors propagate so the enclosing withOrg rolls back both:
// a swallowed error would leave an appointment with no outcome.
// Spec: packages/harness/test/tools.test.ts. G1: runtime-agnostic.
import { z } from "zod";
import type { Tool } from "../types";

// contactId is z.guid() (UUID shape), not z.uuid(): Zod 4's uuid() enforces the RFC-9562 version/variant nibbles, which
// real gen_random_uuid() ids satisfy but test fixtures need not. Checking the shape stops made-up arguments; row-level
// security and the contacts link are the real guarantee.
const schema = z
  .object({
    contactId: z.guid(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    timezone: z.string().min(1),
  })
  .strict();

export const bookAppointment: Tool<z.infer<typeof schema>> = {
  name: "book_appointment",
  description:
    "Book an appointment of the kind this role books, and record the outcome a booking records.",
  schema,
  autonomy: "auto",
  async execute(ctx, args) {
    const booking = ctx.rules?.booking;
    if (!booking) return { ok: false, error: "no_booking_rule" };
    const appt = await ctx.db.query(
      `insert into appointments (org_id, contact_id, kind, starts_at, ends_at, timezone, created_by)
       values ($1, $2, $3, $4, $5, $6, 'agent') returning id`,
      [
        ctx.orgId,
        args.contactId,
        booking.kind,
        args.startsAt,
        args.endsAt,
        args.timezone,
      ],
    );
    const appointmentId = appt.rows[0]?.id;
    await ctx.db.query(
      `insert into outcomes (org_id, contact_id, appointment_id, conversation_id, kind, source)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        ctx.orgId,
        args.contactId,
        appointmentId,
        ctx.conversationId ?? null,
        booking.outcome,
        "agent",
      ],
    );
    return { ok: true, data: { appointmentId } };
  },
};
