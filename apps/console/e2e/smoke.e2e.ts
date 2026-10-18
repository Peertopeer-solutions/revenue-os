// The console's start-up check (the end-to-end smoke layer, docs/tech-stack.md T12), in a real browser: the page
// serves, titled, the app mounts (no white screen) and it starts all the way to its sign-in screen. A console that
// can't start shows "Console configuration incomplete" instead (a build missing a setting, no-settings.e2e.ts),
// which still fills the page, so the check asks for the sign-in screen and fails on the configuration screen; the
// second test proves it does, on the console built without its settings (port 4175).
// Deliberately NOT asserted: any signed-in flow — that is auth.e2e.ts — so this runs with no stack: with no stack
// settings, playwright.config.ts builds the console with dummy settings, enough to reach the sign-in screen.
//
// FILENAME: *.e2e.ts (NOT *.spec.ts) — `bun test` sweeps **/*.spec.ts repo-wide and would execute
// this outside the Playwright runner (runner collision); playwright.config.ts testMatch keys off it.
import { expect, type Page, test } from "@playwright/test";

/** What a console that started shows: its sign-in screen, never the configuration screen. */
async function signInScreenShown(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Sign in to Revenue OS" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Console configuration incomplete" }),
  ).toHaveCount(0);
}

test("the console starts up: titled, mounted, on its sign-in screen", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");

  // Title lives in static index.html — present regardless of which boot path renders.
  await expect(page).toHaveTitle("Revenue OS Console");

  // A non-empty #root means the React app actually mounted (no white screen).
  await expect(page.locator("#root")).not.toBeEmpty();

  await signInScreenShown(page);
  expect(errors).toEqual([]);
});

test("the start-up check fails on the 'configuration incomplete' screen", async ({
  page,
}) => {
  await page.goto("http://localhost:4175/");
  await expect(
    page.getByRole("heading", { name: "Console configuration incomplete" }),
  ).toBeVisible();
  const failure = await signInScreenShown(page).then(
    () => "the start-up check passed",
    (e: Error) => e.message,
  );
  expect(failure).toContain("Sign in to Revenue OS");
});
