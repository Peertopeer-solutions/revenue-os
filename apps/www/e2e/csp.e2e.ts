// Browser check for the marketing site's security headers (public/_headers, which
// Cloudflare Pages sends with every response), run against a production build (the "www"
// project in apps/console/playwright.config.ts, part of `bun run e2e`). vite preview
// ignores _headers, so this test adds them to every response from the site itself. A
// visitor's whole visit (scrolling the page, playing the sample call, opening its
// transcript, stepping through the booking dialog to its last step and pausing the
// animations) must break none of the content security policy, nor must the privacy policy
// and the terms, and a page on another site that frames this one must get nothing.
// The test build sets neither Cal.com nor Plausible, so the dialog runs in preview mode
// and no analytics script loads; test/build.test.ts checks the policy names both hosts.
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { bookingCopy } from "../src/content/booking";
import { hero, sampleCall } from "../src/content/hero";
import { bookDemo, motionToggle } from "../src/content/site";
import { ignoreMediaKeys } from "./media-keys";

// The headers _headers gives every page: the indented "Name: value" lines under "/*".
const headers: Record<string, string> = {};
let rule = "";
for (const line of readFileSync(
  new URL("../public/_headers", import.meta.url),
  "utf8",
).split("\n")) {
  if (/^\s*(#|$)/.test(line)) continue;
  if (!/^\s/.test(line)) rule = line.trim();
  else if (rule === "/*") {
    const at = line.indexOf(":");
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
}

// Serve the site the way Pages will: every response from it carries those headers.
async function withHeaders(page: Page, site: string) {
  await page.route(
    (url) => url.origin === site,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), ...headers },
      });
    },
  );
}

test("a visitor's whole visit breaks none of the content security policy", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { violations: seen });
    document.addEventListener("securitypolicyviolation", (e) =>
      seen.push(`${e.violatedDirective} refused ${e.blockedURI}`),
    );
  });
  await page.addInitScript(ignoreMediaKeys);
  await withHeaders(page, new URL(String(baseURL)).origin);
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toBe(
    headers["Content-Security-Policy"],
  );

  // Top to bottom, half a screen at a time, so every section reveals and plays.
  await page.evaluate(async () => {
    const end = document.documentElement.scrollHeight;
    for (let y = 0; y <= end; y += innerHeight / 2) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });

  // The sample call plays for a second, then its transcript opens.
  await page.getByRole("button", { name: hero.secondary }).click();
  const pause = page.getByRole("button", { name: sampleCall.pause });
  await expect(pause).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(pause).toBeVisible();
  await page.getByText(sampleCall.transcriptLabel).click();
  await expect(
    page.getByText(sampleCall.transcript[0]?.text ?? ""),
  ).toBeVisible();

  // The booking dialog, from a time to the preview's last step.
  await page.getByRole("button", { name: bookDemo }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(bookingCopy.preview)).toBeVisible();
  await dialog
    .getByRole("button", { name: /\d:\d\d\s[AP]M/ })
    .first()
    .click();
  const { name, email, company } = bookingCopy.fields;
  await dialog.getByLabel(name, { exact: true }).fill("Test Visitor");
  await dialog.getByLabel(email).fill("visitor@example.com");
  await dialog.getByLabel(company).fill("Example Homes");
  await dialog.getByRole("button", { name: bookingCopy.submit }).click();
  await expect(
    dialog.getByRole("heading", { name: bookingCopy.previewConfirm.title }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: bookingCopy.close }).last().click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: motionToggle.pause }).click();
  await expect(
    page.getByRole("button", { name: motionToggle.play }),
  ).toBeVisible();

  expect(
    await page.evaluate(
      () => (window as unknown as { violations: string[] }).violations,
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("the privacy policy and the terms break none of the content security policy", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { violations: seen });
    document.addEventListener("securitypolicyviolation", (e) =>
      seen.push(`${e.violatedDirective} refused ${e.blockedURI}`),
    );
  });
  await withHeaders(page, new URL(String(baseURL)).origin);
  for (const [path, title] of [
    ["/privacy", "Privacy policy"],
    ["/terms", "Terms of service"],
  ]) {
    const response = await page.goto(path);
    expect(response?.headers()["content-security-policy"]).toBe(
      headers["Content-Security-Policy"],
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => (window as unknown as { violations: string[] }).violations,
      ),
      path,
    ).toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("a page on another site that frames this one gets nothing", async ({
  page,
  baseURL,
}) => {
  const site = new URL(String(baseURL)).origin;
  const refused: string[] = [];
  page.on("console", (m) => {
    if (/frame-ancestors/.test(m.text())) refused.push(m.text());
  });
  await withHeaders(page, site);
  await page.route("http://elsewhere.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe src="${site}/"></iframe>`,
    }),
  );
  await page.goto("http://elsewhere.test/");
  await expect.poll(() => refused.length).toBeGreaterThan(0);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame?.url()).not.toBe(`${site}/`);
  expect(await frame?.locator("#root").count()).toBe(0);
});
