// A person marks a lead do-not-call in the console, against the real local stack (console, worker API, local
// Supabase): the dev login signs in, imports a lead of its own through the worker's CSV import, opens Contacts,
// clicks "Mark do not call", "Cancel" (nothing is blocked), "Mark do not call" again and "Block", and the lead's row shows the "Do not call" badge, still there after a
// reload, with no button left to block or lift it. That the lead's next message and call are then refused is
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

function env(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} must be set to run the do-not-call e2e spec`);
  return value;
}

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
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(DEV_LOGIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(DEV_LOGIN_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/o/${orgId}/home$`));

    await page.goto(`/o/${orgId}/contacts`);
    const row = page.getByRole("row").filter({ hasText: `${name} Lead` });
    const mark = row.getByRole("button", { name: "Mark do not call" });
    const asked = row.getByText("Block every call and message?");
    await mark.click();
    await expect(asked).toBeVisible();
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(asked).toHaveCount(0);
    await expect(row.getByText("Do not call", { exact: true })).toHaveCount(0);
    await mark.click();
    await row.getByRole("button", { name: "Block", exact: true }).click();
    await expect(row.getByText("Do not call", { exact: true })).toBeVisible();

    await page.reload();
    await expect(row.getByText("Do not call", { exact: true })).toBeVisible();
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
