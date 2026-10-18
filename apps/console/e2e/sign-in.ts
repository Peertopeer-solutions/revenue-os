// Shared by the browser checks that work as the dev login on the seeded workspace (global-setup.ts seeds it and
// names it in E2E_ORG_ID): signs in through the console's own sign-in screen and returns the workspace's id. Not a
// check itself (no .e2e.ts suffix), so Playwright runs nothing from it.
import { expect, type Page } from "@playwright/test";
import {
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_PASSWORD,
} from "../../../scripts/dev-login";

/** A setting global-setup.ts or the local stack provides; the check stops with a plain reason without it. */
export function env(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} must be set: run the browser checks on the local stack (bun run local bun run e2e)`,
    );
  return value;
}

/** Signs the dev login in at /login and waits for its workspace's home; the workspace's id. */
export async function signIn(page: Page): Promise<string> {
  const orgId = env("E2E_ORG_ID");
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(DEV_LOGIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEV_LOGIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${orgId}/home$`));
  return orgId;
}
