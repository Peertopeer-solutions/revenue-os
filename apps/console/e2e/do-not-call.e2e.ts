// A person marks a lead do-not-call in the console, against the real local stack (console, worker API, local
// Supabase): the dev login signs in, imports a lead of its own through the worker's CSV import, opens Contacts, finds
// it by name, clicks "Mark do not call", "Cancel" (nothing is blocked), "Mark do not call" again and "Block" while the
// worker's answer is made a refusal (the row says only an operator or admin may block), then "Block" again, and the
// row shows the "Do not call" badge, found again by number after a reload, with no button left to block or lift it. That the lead's next message and call are then refused is
// services/worker/test/do-not-call.test.ts. The lead is deleted afterwards, so the dev login's workspace keeps only
// its seeded rows. Runtime inputs, read inside the test: E2E_ORG_ID (global-setup.ts), SUPABASE_URL,
// SUPABASE_ANON_KEY, VITE_API_URL and LOCAL_DB_URL (`bun run local`). FILENAME: *.e2e.ts, so `bun test` leaves it.
import { randomInt, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import {
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_PASSWORD,
} from "../../../scripts/dev-login";
import { isLocalUrl } from "../../../scripts/local-url";
import { env, signIn } from "./sign-in";

test("a person marks a lead do-not-call on the Contacts screen, and the block stays", async ({
  page,
}) => {
  const [orgId, dbUrl, apiUrl] = [
    env("E2E_ORG_ID"),
    env("LOCAL_DB_URL"),
    env("VITE_API_URL"),
  ];
  if (![dbUrl, apiUrl].every(isLocalUrl))
    throw new Error("the do-not-call e2e spec runs only on this machine");
  const name = `Check${randomUUID().slice(0, 8)}`;
  const phone = `+9197${randomInt(10_000_000, 100_000_000)}`;

  const grant = await fetch(
    `${env("SUPABASE_URL")}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env("SUPABASE_ANON_KEY"),
      },
      body: JSON.stringify({
        email: DEV_LOGIN_EMAIL,
        password: DEV_LOGIN_PASSWORD,
      }),
    },
  );
  const { access_token: token } = (await grant.json()) as {
    access_token: string;
  };
  const imported = await fetch(`${apiUrl}/orgs/${orgId}/contacts/import`, {
    method: "POST",
    headers: { "content-type": "text/csv", authorization: `Bearer ${token}` },
    body: `first_name,last_name,phone\n${name},Lead,${phone}\n`,
  });
  expect(await imported.json()).toEqual({ created: 1, merged: 0, invalid: 0 });

  const db = new pg.Pool({ connectionString: dbUrl });
  try {
    await signIn(page);

    const find = async (q: string) => {
      await page.getByLabel("Search leads by name or phone number").fill(q);
      await page.getByRole("button", { name: "Search", exact: true }).click();
    };
    await page.goto(`/o/${orgId}/contacts`);
    await find(name);
    const rows = page.locator("tbody").getByRole("row");
    await expect(rows).toHaveCount(1);
    const row = rows.filter({ hasText: `${name} Lead` });
    const mark = row.getByRole("button", { name: "Mark do not call" });
    const block = row.getByRole("button", { name: "Block", exact: true });
    const asked = row.getByText("Block every call and message?");
    const badge = row.getByText("Do not call", { exact: true });
    await mark.click();
    await expect(asked).toBeVisible();
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(asked).toHaveCount(0);
    await expect(badge).toHaveCount(0);

    // A save the worker refuses says why, and blocks nothing.
    const refuse = "**/contacts/*/do-not-call";
    await page.route(refuse, (r) =>
      r.request().method() === "POST"
        ? r.fulfill({
            status: 403,
            json: { error: "forbidden" },
            headers: {
              "access-control-allow-origin":
                r.request().headers().origin ?? "*",
            },
          })
        : r.continue(),
    );
    await mark.click();
    await block.click();
    await expect(row.getByRole("alert")).toHaveText(
      "Only an operator or admin can block a lead.",
    );
    await page.unroute(refuse);
    await block.click();
    await expect(badge).toBeVisible();

    await page.reload();
    await find(phone.slice(-6));
    await expect(rows).toHaveCount(1);
    await expect(badge).toBeVisible();
    await expect(row.getByRole("button")).toHaveCount(0);
  } finally {
    await db.query(
      `delete from contacts where org_id = $1 and id = (
         select contact_id from contact_identities where org_id = $1 and kind = 'phone' and value = $2)`,
      [orgId, phone],
    );
    await db.end();
  }
});
