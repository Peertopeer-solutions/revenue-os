// The console's guardrail settings: the Settings page's "Guardrails" section. These render the real SettingsPage on
// the server with its two data hooks faked through mockModule (process-wide, so afterAll restores the real modules).
// What the hooks themselves send, and what they refresh, is guardrails-save.test.tsx.
import { afterAll, describe, expect, it } from "bun:test";
import { ApiError, GuardrailPolicyInputSchema } from "@revenue-os/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Router } from "wouter";
import * as realGuardrailsApi from "../src/features/guardrails/api";
import * as realOrgsApi from "../src/features/orgs/api";
import { notSaved } from "../src/pages/Settings/SaveStatus";
import { apiErrorFor, mockModule } from "./test-utils";

const ORG = "11111111-1111-4111-8111-111111111111";
const orgFixture = { id: ORG, name: "Acme Co", slug: "acme", role: "admin" };

// The four seeded policies (real_estate.sql:45-48) as the query's happy payload.
const policies = [
  {
    key: "quiet_hours",
    config: { start: "21:00", end: "09:00", tz: "contact" },
    active: true,
    updated_at: "2026-07-01T00:00:00Z",
  },
  {
    key: "attempt_caps",
    config: {
      voice: { max: 3, per_hours: 72 },
      whatsapp: { max: 2, per_hours: 24 },
    },
    active: true,
    updated_at: "2026-07-01T00:00:00Z",
  },
  {
    key: "dnc",
    config: { hard_stop: true },
    active: true,
    updated_at: "2026-07-01T00:00:00Z",
  },
  {
    key: "autonomy",
    config: { book_appointment: "auto", send_quote: "approval" },
    active: true,
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const loadingState = { isLoading: true, isError: false, data: undefined };
const errorState = { isLoading: false, isError: true, data: undefined };
const ok = (data: unknown) => ({ isLoading: false, isError: false, data });

// SettingsPage reads these live via the mocked hooks. orgs is pinned happy so OrganizationCard
// renders cleanly and never contributes the strings the guardrail assertions look for.
let guardrailsResult: unknown = loadingState;
const restoreOrgs = mockModule("../src/features/orgs/api", realOrgsApi, {
  useOrgsQuery: () => ok([orgFixture]),
});
// The hooks SettingsPage and its two forms call, faked over the real module. `saveResult` is what each form's
// save call reports; a fresh form has made none.
const idle = {
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null,
};
let saveResult: unknown = idle;
const restoreGuardrails = mockModule(
  "../src/features/guardrails/api",
  realGuardrailsApi,
  {
    useGuardrailPoliciesQuery: () => guardrailsResult,
    useUpdateGuardrailPolicy: () => ({
      mutate: () => {},
      ...(saveResult as object),
    }),
  },
);

afterAll(() => {
  restoreOrgs();
  restoreGuardrails();
});

const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

async function renderSettings(): Promise<string> {
  const { SettingsPage } = await import("../src/pages/Settings/index");
  return renderToStaticMarkup(
    <Router ssrPath={`/o/${ORG}/settings`}>
      <Route path="/o/:orgId/settings">
        <SettingsPage />
      </Route>
    </Router>,
  );
}

describe("Settings Guardrails section — honest data states", () => {
  it("loading → calm 'Loading…'", async () => {
    guardrailsResult = loadingState;
    expect(text(await renderSettings())).toContain("Loading…");
  });

  it("error → an 'Unable to load' state, never silent", async () => {
    guardrailsResult = errorState;
    expect(text(await renderSettings())).toContain("Unable to load");
  });

  // behaviour already on main: main's Settings page already shows none of the old placeholder's words; its two new checks replace a test that read the page's source as text
  it("a fresh org with zero policies is honest: no fabricated config, no dead placeholder", async () => {
    guardrailsResult = ok({ policies: [] });
    const html = await renderSettings();
    expect(html).not.toContain("21:00"); // nothing invented when there's no data
    expect(text(html)).not.toContain("will live here"); // dead placeholder is gone
    expect(text(html)).not.toContain("backend wave");
    expect(text(html)).not.toContain("hasn't shipped");
  });
});

describe("Settings Guardrails section — renders each policy, editable vs read-only", () => {
  it("renders all four policies (tolerant of humanized labels)", async () => {
    guardrailsResult = ok({ policies });
    const t = text(await renderSettings()).toLowerCase();
    expect(t).toMatch(/quiet.?hours/);
    expect(t).toMatch(/attempt.?caps|attempts/);
    expect(t).toMatch(/dnc|do not contact/);
    expect(t).toMatch(/autonomy/);
  });

  it("quiet_hours is EDITABLE: a form bound to the live start value + a submit control", async () => {
    guardrailsResult = ok({ policies });
    const html = await renderSettings();
    expect(html).toContain("<form");
    expect(html).toContain('value="21:00"'); // current start rendered in an editable input
    expect(html).toContain('type="submit"');
  });

  it("autonomy is EDITABLE: a <select> offering the tier, current tier shown", async () => {
    guardrailsResult = ok({ policies });
    const html = await renderSettings();
    expect(html).toContain("<select");
    expect(html).toContain("approval"); // the seeded send_quote tier
  });

  it("exactly two policies are editable (quiet_hours + autonomy expose a submit)", async () => {
    guardrailsResult = ok({ policies });
    const html = await renderSettings();
    expect((html.match(/type="submit"/g) ?? []).length).toBe(2);
  });

  it("attempt_caps + dnc are READ-ONLY: values shown as text, never as editable inputs", async () => {
    guardrailsResult = ok({ policies });
    const html = await renderSettings();
    const t = text(html);
    expect(t).toContain("voice"); // attempt_caps channels visible (read-only)
    expect(t).toContain("whatsapp");
    expect(html).not.toContain('value="72"'); // not an editable per_hours input
    expect(html).not.toContain('value="24"');
  });
});

describe("Settings Guardrails section — what each form says about its save", () => {
  it("each editable policy is its own form, named for it", async () => {
    guardrailsResult = ok({ policies });
    saveResult = idle;
    const html = await renderSettings();
    expect(html).toContain('<form aria-label="Quiet hours"');
    expect(html).toContain('<form aria-label="Autonomy"');
    expect(html).not.toContain('role="status"'); // nothing said before the first save
    expect(html).not.toContain('role="alert"');
  });

  it("while a save runs, its form says 'Saving…' and its fields and Save button wait", async () => {
    guardrailsResult = ok({ policies });
    saveResult = { ...idle, isPending: true };
    const html = await renderSettings();
    expect(text(html)).toContain("Saving…");
    expect(
      (html.match(/<button[^>]*type="submit"[^>]*disabled=""/g) ?? []).length,
    ).toBe(2);
    // Quiet hours' start, end and time zone, and autonomy's two tools: none can change under a running save.
    expect(
      (html.match(/<(input|select)\b[^>]*disabled=""/g) ?? []).length,
    ).toBe(5);
  });

  it("with no save running, every field can be changed", async () => {
    guardrailsResult = ok({ policies });
    saveResult = { ...idle, isSuccess: true };
    const html = await renderSettings();
    expect(html).not.toMatch(/<(input|select|button)\b[^>]*disabled=""/);
  });

  it("a save the API took says 'Saved.'", async () => {
    guardrailsResult = ok({ policies });
    saveResult = { ...idle, isSuccess: true };
    expect(text(await renderSettings())).toContain("Saved.");
  });

  it("a save that failed says why, as an alert", async () => {
    guardrailsResult = ok({ policies });
    saveResult = { ...idle, isError: true, error: await apiErrorFor(500) };
    const html = await renderSettings();
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Not saved: the API answered 500. Try again.");
    expect(text(html)).not.toContain("Saved.");
  });

  it("each kind of failure is told in a person's words", async () => {
    expect(notSaved(await apiErrorFor(0))).toBe(
      "Not saved: the API can't be reached. Try again.",
    );
    expect(
      notSaved(new ApiError(0, "PUT", "/orgs/x/guardrail-policies", "timeout")),
    ).toBe("Not saved: the API took too long to answer. Try again.");
    expect(notSaved(await apiErrorFor(403))).toBe(
      "Not saved: only an admin can change guardrails.",
    );
    expect(notSaved(await apiErrorFor(400))).toBe(
      "Not saved: the API answered 400. Try again.",
    );
    // The shared schema refuses a field left empty before anything is sent: its error, not an API error.
    const emptyStart = GuardrailPolicyInputSchema.safeParse({
      key: "quiet_hours",
      config: { start: "", end: "09:00", tz: "contact" },
    }).error;
    expect(emptyStart).toBeDefined();
    expect(notSaved(emptyStart)).toBe("Not saved: fill in every field.");
    // Anything else (an answer that isn't JSON, say) claims nothing about the fields.
    expect(notSaved(new SyntaxError("Unexpected token <"))).toBe(
      "Not saved: something went wrong. Try again.",
    );
  });
});
