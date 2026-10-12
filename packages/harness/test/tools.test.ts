// The production tool catalog (book_appointment, update_contact, send_confirmation). Two tiers:
//   • ENV-FREE unit — Zod validation, injected-port dispatch, catalog registration. Stub the
//     ctx.db door in-memory; no Postgres. These run in every worktree.
//   • [CI-owned integration] — real rows PERSIST via withOrg + real RLS (rollback atomicity,
//     cross-tenant denial). skipIf(no DATABASE_URL): they run wherever the local stack's
//     settings are set (`bun run gate`, CI).
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createPool, withOrg } from "@revenue-os/db";
import pg from "pg";
import { testCompanies } from "../../../tests/test-companies";
import { buildCatalog } from "../src/tools";
import { bookAppointment } from "../src/tools/book-appointment";
import {
  makeSendConfirmation,
  type SendPort,
} from "../src/tools/send-confirmation";
import { updateContact } from "../src/tools/update-contact";
import type { OrgScopedDb } from "../src/types";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTACT = "22222222-2222-2222-2222-222222222222";
const validBook = {
  contactId: CONTACT,
  startsAt: "2026-08-01T10:00:00.000Z",
  endsAt: "2026-08-01T10:30:00.000Z",
  timezone: "Asia/Kolkata",
};

type Recorded = { text: string; values: unknown[] };

/** In-memory OrgScopedDb: records every query; can fail on a text pattern; programmable rows. */
function recordingDb(opts?: {
  failOn?: RegExp;
  responder?: (text: string) => {
    rows: Record<string, unknown>[];
    rowCount: number;
  };
}): { db: OrgScopedDb; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const db: OrgScopedDb = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (opts?.failOn?.test(text)) throw new Error("simulated db failure");
      return opts?.responder?.(text) ?? { rows: [], rowCount: 0 };
    },
  };
  return { db, calls };
}

/** Appointment insert returns a fresh id; everything else a bland 1-row result. */
const apptResponder = (apptId: string) => (text: string) =>
  /insert\s+into\s+appointments/i.test(text)
    ? { rows: [{ id: apptId }], rowCount: 1 }
    : { rows: [], rowCount: 1 };

// ── book_appointment ─────────────────────────────────────────────────────────────────────────
describe("book_appointment", () => {
  it("schema REJECTS malformed args (missing contactId, non-uuid, missing slot/time)", () => {
    // Tool arguments are validated before execute (AGENTS.md → Agent harness): hallucinated/partial args never reach it.
    expect(
      bookAppointment.schema.safeParse({
        startsAt: validBook.startsAt,
        endsAt: validBook.endsAt,
        timezone: validBook.timezone,
      }).success,
    ).toBe(false); // no contactId
    expect(
      bookAppointment.schema.safeParse({
        ...validBook,
        contactId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      bookAppointment.schema.safeParse({ contactId: CONTACT }).success,
    ).toBe(false); // no slot/time
  });

  it("schema ACCEPTS a well-formed booking", () => {
    expect(bookAppointment.schema.safeParse(validBook).success).toBe(true);
  });

  it("execute writes an appointments row AND an attributed site_visit_booked outcome on the same ctx.db tx", async () => {
    const { db, calls } = recordingDb({ responder: apptResponder("appt-abc") });
    const res = await bookAppointment.execute({ orgId: ORG, db }, validBook);
    expect(res.ok).toBe(true);

    const appt = calls.find((c) =>
      /insert\s+into\s+appointments/i.test(c.text),
    );
    const outcome = calls.find((c) => /insert\s+into\s+outcomes/i.test(c.text));
    expect(appt).toBeDefined();
    expect(outcome).toBeDefined();
    // attribution: the outcome links the freshly-created appointment + records an agent-sourced booking
    expect(outcome?.values).toContain("appt-abc"); // appointment_id from the RETURNING id
    expect(outcome?.values).toContain("site_visit_booked"); // outcomes.kind (005_outcomes.sql)
    expect(outcome?.values).toContain("agent"); // outcomes.source = app.actor_type
    // both writes on the single ctx.db handle (one enclosing withOrg tx — no second connection)
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("execute is atomic: an outcome-insert failure PROPAGATES so the enclosing withOrg rolls back both rows", async () => {
    const { db, calls } = recordingDb({
      responder: apptResponder("appt-xyz"),
      failOn: /insert\s+into\s+outcomes/i,
    });
    // must reject (not swallow) — a swallowed error would commit an orphan appointment.
    await expect(
      bookAppointment.execute({ orgId: ORG, db }, validBook),
    ).rejects.toThrow();
    // it got past the appointment insert before the outcome insert blew up
    expect(
      calls.some((c) => /insert\s+into\s+appointments/i.test(c.text)),
    ).toBe(true);
  });
});

// ── update_contact ───────────────────────────────────────────────────────────────────────────
describe("update_contact", () => {
  it("schema REJECTS malformed args (non-uuid id, empty update, unknown field)", () => {
    expect(
      updateContact.schema.safeParse({ contactId: "nope", firstName: "A" })
        .success,
    ).toBe(false);
    expect(updateContact.schema.safeParse({ contactId: CONTACT }).success).toBe(
      false,
    ); // nothing to update
    expect(
      updateContact.schema.safeParse({
        contactId: CONTACT,
        firstName: "A",
        bogus: 1,
      }).success,
    ).toBe(false);
  });

  it("execute updates the named contact fields through ctx.db (the RLS-scoped door)", async () => {
    const { db, calls } = recordingDb({
      responder: () => ({ rows: [], rowCount: 1 }),
    });
    const res = await updateContact.execute(
      { orgId: ORG, db },
      { contactId: CONTACT, firstName: "Renamed" },
    );
    expect(res.ok).toBe(true);
    const upd = calls.find((c) => /update\s+contacts\s+set/i.test(c.text));
    expect(upd).toBeDefined();
    expect(upd?.values).toContain(CONTACT);
    expect(upd?.values).toContain("Renamed");
    expect(upd?.values).toContain(ORG); // the company filter, beside the database's own rules
  });

  it("execute reports an update that matched no lead (a wrong id, or another company's lead) as contact_not_found", async () => {
    const { db } = recordingDb(); // answers rowCount 0
    expect(
      await updateContact.execute(
        { orgId: ORG, db },
        { contactId: CONTACT, firstName: "Renamed" },
      ),
    ).toEqual({ ok: false, error: "contact_not_found" });
  });
});

// ── send_confirmation (injected guarded port) ────────────────────────────────────────────────
describe("send_confirmation", () => {
  it("schema REJECTS malformed args (non-uuid id, empty body, bad channel)", () => {
    const tool = makeSendConfirmation({
      send: mock(async () => ({ ok: true })),
    });
    expect(
      tool.schema.safeParse({
        contactId: "nope",
        channel: "whatsapp",
        body: "hi",
      }).success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({
        contactId: CONTACT,
        channel: "whatsapp",
        body: "",
      }).success,
    ).toBe(false);
    expect(
      tool.schema.safeParse({
        contactId: CONTACT,
        channel: "carrier-pigeon",
        body: "hi",
      }).success,
    ).toBe(false);
  });

  it("execute DISPATCHES through the injected sender port (guardrails before every send — the only send path) and returns its result", async () => {
    const send = mock(async () => ({ ok: true }));
    const tool = makeSendConfirmation({ send });
    const res = await tool.execute(
      { orgId: ORG, db: recordingDb().db },
      {
        contactId: CONTACT,
        channel: "whatsapp",
        body: "You're booked for Sat 10am.",
      },
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: CONTACT }),
    );
    expect(res.ok).toBe(true);
  });

  it("execute cannot send independently of the port: a port failure surfaces as tool failure", async () => {
    const send = mock(async () => ({ ok: false }));
    const tool = makeSendConfirmation({ send });
    const res = await tool.execute(
      { orgId: ORG, db: recordingDb().db },
      { contactId: CONTACT, channel: "email", body: "hi" },
    );
    expect(send).toHaveBeenCalledTimes(1); // no bypass path that skips the guarded doorway
    expect(res.ok).toBe(false);
  });
});

// ── Registration + exposure to runTurn ───────────────────────────────────────────────────────
describe("catalog registration", () => {
  const NAMES = [
    "book_appointment",
    "update_contact",
    "send_confirmation",
  ] as const;
  const allowed = [...NAMES] as string[];
  const send: SendPort = mock(async () => ({ ok: true }));

  it("buildCatalog registers all three production tools under their stable names", () => {
    const reg = buildCatalog({ send });
    for (const name of NAMES) expect(reg.get(name, allowed)).toBeDefined();
  });

  it("registered tools carry their spec'd autonomy tiers (auto — guarded sends, not approval gates)", () => {
    // All three are 'auto': an 'approval' tier would route every booking/send to a human task
    // (loop.ts) and break autonomous operation. Send safety lives in the guarded channels
    // doorway, not in a per-tool approval gate. Flip a value here + in the tool if product disagrees.
    const reg = buildCatalog({ send });
    expect(reg.get("book_appointment", allowed)?.autonomy).toBe("auto");
    expect(reg.get("update_contact", allowed)?.autonomy).toBe("auto");
    expect(reg.get("send_confirmation", allowed)?.autonomy).toBe("auto");
  });

  it("registered tools are exposed to runTurn via registry.specs() for the allowed set", () => {
    const reg = buildCatalog({ send });
    const specNames = reg
      .specs(allowed)
      .map((s) => s.name)
      .sort();
    expect(specNames).toEqual([...NAMES].sort());
  });
});

// ── [CI-owned integration] real persistence + RLS. skipIf(no DATABASE_URL) — env-free worktrees
//    skip these by rail; CI (supabase up) runs them. Verifies the assertions a stubbed ctx.db
//    cannot: rows PERSIST, the tx rolls back atomically, and RLS denies cross-tenant reach.
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)(
  "tool catalog — persistence & tenancy [CI-owned integration]",
  () => {
    // Pools built in beforeAll (never when skipped) — no idle handles in env-free worktrees.
    let admin: pg.Pool;
    let appService: pg.Pool;
    let companies: ReturnType<typeof testCompanies>;
    let orgA = "";
    let orgB = "";
    let contactA = "";

    beforeAll(async () => {
      admin = new pg.Pool({
        connectionString:
          process.env.LOCAL_DB_URL ||
          "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        max: 2,
      });
      appService = createPool(
        process.env.DATABASE_URL ||
          "postgresql://app_service:app_service_local@127.0.0.1:54322/postgres",
      );
      companies = testCompanies(admin);
      orgA = (await companies.add("Tools A")).id;
      orgB = (await companies.add("Tools B")).id;
      const c = await admin.query(
        `insert into contacts (org_id, first_name) values ($1, 'OrgA-Owned') returning id`,
        [orgA],
      );
      contactA = c.rows[0].id;
    });

    afterAll(async () => {
      await companies.cleanup();
      await appService.end();
      await admin.end();
    });

    it("book_appointment persists an appointments row + an attributed site_visit_booked outcome", async () => {
      await withOrg(appService, orgA, (tx) =>
        bookAppointment.execute(
          { orgId: orgA, db: tx },
          { ...validBook, contactId: contactA },
        ),
      );
      const appt = await admin.query(
        `select id from appointments where org_id = $1 and contact_id = $2`,
        [orgA, contactA],
      );
      expect(appt.rowCount).toBe(1);
      const outcome = await admin.query(
        `select kind, source, appointment_id from outcomes where org_id = $1 and contact_id = $2`,
        [orgA, contactA],
      );
      expect(outcome.rowCount).toBe(1);
      expect(outcome.rows[0].kind).toBe("site_visit_booked");
      expect(outcome.rows[0].source).toBe("agent");
      expect(outcome.rows[0].appointment_id).toBe(appt.rows[0].id); // outcome attributes the appointment
    });

    it("cross-tenant denial: org B cannot see org A's appointment or outcome (RLS)", async () => {
      // relies on the booking from the previous test (Bun runs in source order)
      await withOrg(appService, orgB, async (tx) => {
        const a = await tx.query(
          `select id from appointments where contact_id = $1`,
          [contactA],
        );
        expect(a.rowCount).toBe(0);
        const o = await tx.query(
          `select id from outcomes where contact_id = $1`,
          [contactA],
        );
        expect(o.rowCount).toBe(0);
      });
    });

    it("atomicity: a failure anywhere in the tx rolls back BOTH the appointment and the outcome", async () => {
      const before = await admin.query(
        `select count(*)::int n from appointments where org_id = $1 and contact_id = $2`,
        [orgA, contactA],
      );
      await expect(
        withOrg(appService, orgA, async (tx) => {
          await bookAppointment.execute(
            { orgId: orgA, db: tx },
            { ...validBook, contactId: contactA },
          );
          throw new Error("boom after book"); // forced failure AFTER the appointment insert
        }),
      ).rejects.toThrow("boom");
      const after = await admin.query(
        `select count(*)::int n from appointments where org_id = $1 and contact_id = $2`,
        [orgA, contactA],
      );
      expect(after.rows[0].n).toBe(before.rows[0].n); // nothing from the doomed booking survived
      const outc = await admin.query(
        `select count(*)::int n from outcomes where org_id = $1 and appointment_id is null`,
        [orgA],
      );
      expect(outc.rows[0].n).toBe(0); // no orphan outcome
    });

    it("cross-tenant denial: update_contact under org B cannot mutate org A's contact (RLS)", async () => {
      const result = await withOrg(appService, orgB, (tx) =>
        updateContact.execute(
          { orgId: orgB, db: tx },
          { contactId: contactA, firstName: "Hacked" },
        ),
      );
      expect(result).toEqual({ ok: false, error: "contact_not_found" });
      const row = await admin.query(
        `select first_name from contacts where id = $1`,
        [contactA],
      );
      expect(row.rows[0].first_name).toBe("OrgA-Owned"); // unchanged — RLS scoped the update to org B
    });
  },
);
