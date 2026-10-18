// Saving calling hours in Settings (the workspace's quiet-hours window), as the dev login on the seeded workspace
// against the real local stack: a save says "Saved." and the new hours are still there after a reload; a save the
// API fails shows its error and changes nothing. The workspace's quiet-hours setting is put back as it was at the
// end, whatever happened, so the check is safe on a workspace people use. FILENAME: *.e2e.ts, so `bun test` leaves
// it alone.
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { isLocalUrl } from "../../../scripts/local-url";
import { env, signIn } from "./sign-in";

const quietHours = (page: Page) =>
  page.getByRole("form", { name: "Quiet hours" });

test("calling hours saved in Settings are kept after a reload, and a save that fails shows an error and changes nothing", async ({
  page,
}) => {
  const dbUrl = env("LOCAL_DB_URL");
  if (!isLocalUrl(dbUrl))
    throw new Error(
      "the settings check changes settings only in a database on this machine",
    );
  const orgId = env("E2E_ORG_ID");
  const db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  const {
    rows: [before],
  } = await db.query<{ config: unknown; active: boolean }>(
    `select config, active from guardrail_policies where org_id = $1 and key = 'quiet_hours'`,
    [orgId],
  );
  try {
    if (!before)
      throw new Error(
        "the seeded workspace has no quiet-hours setting: run bun run db:seed real_estate",
      );
    await signIn(page);
    await page.goto(`/o/${orgId}/settings`);

    // A save: "Saved.", and the hours are still there after a reload.
    await quietHours(page).getByLabel("Start").fill("20:30");
    await quietHours(page).getByLabel("End").fill("09:30");
    await quietHours(page).getByRole("button", { name: "Save" }).click();
    await expect(quietHours(page).getByRole("status")).toHaveText("Saved.");
    await page.reload();
    await expect(quietHours(page).getByLabel("Start")).toHaveValue("20:30");
    await expect(quietHours(page).getByLabel("End")).toHaveValue("09:30");

    // A save the API fails: its error is shown, and after a reload the saved hours are unchanged.
    const policies = `**/orgs/${orgId}/guardrail-policies`;
    await page.route(policies, (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, json: { error: "internal_error" } })
        : route.fallback(),
    );
    await quietHours(page).getByLabel("Start").fill("22:15");
    await quietHours(page).getByRole("button", { name: "Save" }).click();
    await expect(quietHours(page).getByRole("alert")).toHaveText(
      "Not saved: the API answered 500. Try again.",
    );
    await page.unroute(policies);
    await page.reload();
    await expect(quietHours(page).getByLabel("Start")).toHaveValue("20:30");
  } finally {
    if (before)
      await db.query(
        `update guardrail_policies set config = $2, active = $3 where org_id = $1 and key = 'quiet_hours'`,
        [orgId, before.config, before.active],
      );
    await db.end();
  }
});
