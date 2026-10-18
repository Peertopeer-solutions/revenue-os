// Saving calling hours in Settings (the workspace's quiet-hours window), as the dev login on the seeded workspace
// against the real local stack: a save says "Saved." and the new hours are still there after a reload; a change
// made after it clears "Saved." and, unsaved, is not kept; a save the API fails shows its error and changes nothing. The workspace's quiet-hours setting is put back as it was at the
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
  const stored = async () =>
    (
      await db.query<{
        config: { start?: string; end?: string };
        active: boolean;
      }>(
        `select config, active from guardrail_policies where org_id = $1 and key = 'quiet_hours'`,
        [orgId],
      )
    ).rows[0];
  const before = await stored();
  try {
    if (!before)
      throw new Error(
        "the seeded workspace has no quiet-hours setting: run bun run db:seed real_estate",
      );
    // Hours unlike the stored ones, so the save has something to change.
    const start = ["20:30", "20:15"].find((t) => t !== before.config.start);
    const end = ["09:30", "09:15"].find((t) => t !== before.config.end);
    await signIn(page);
    await page.goto(`/o/${orgId}/settings`);

    // A save: "Saved.", the hours in the database, and still on screen after a reload.
    await quietHours(page)
      .getByLabel("Start")
      .fill(start ?? "");
    await quietHours(page)
      .getByLabel("End")
      .fill(end ?? "");
    await quietHours(page).getByRole("button", { name: "Save" }).click();
    await expect(quietHours(page).getByRole("status")).toHaveText("Saved.");
    expect((await stored())?.config).toMatchObject({ start, end });
    // Changing a field again clears "Saved.": the hours on screen are no longer the saved ones, and are not kept.
    await quietHours(page).getByLabel("Start").fill("20:45");
    await expect(quietHours(page).getByRole("status")).toHaveCount(0);
    await page.reload();
    await expect(quietHours(page).getByLabel("Start")).toHaveValue(start ?? "");
    await expect(quietHours(page).getByLabel("End")).toHaveValue(end ?? "");

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
    await expect(quietHours(page).getByLabel("Start")).toHaveValue(start ?? "");
    expect((await stored())?.config).toMatchObject({ start, end });
  } finally {
    if (before)
      await db.query(
        `update guardrail_policies set config = $2, active = $3 where org_id = $1 and key = 'quiet_hours'`,
        [orgId, before.config, before.active],
      );
    await db.end();
  }
});
