// Browser check of the two legal pages (privacy.html at /privacy, terms.html at /terms), run against a production
// build (the "www" project in apps/console/playwright.config.ts, part of `bun run e2e`). Meta takes the privacy
// policy's address only if its crawler gets the page itself: HTTP 200, no redirect, no sign-in, clearly titled. That
// crawler runs no JavaScript, so each page is read here with JavaScript off and must carry its whole text, and the
// privacy policy the promises Meta's WhatsApp terms and India's DPDP Act ask of it. The landing page's footer links
// both. test/build.test.ts's build puts them beside index.html, where Cloudflare Pages serves them the same way.
import { expect, test } from "@playwright/test";

const PAGES = [
  { path: "/privacy", title: "Privacy policy", other: "/terms" },
  { path: "/terms", title: "Terms of service", other: "/privacy" },
];

test.describe("with JavaScript off, as Meta's crawler reads them", () => {
  test.use({ javaScriptEnabled: false });

  for (const { path, title, other } of PAGES)
    test(`${path} answers 200 with no redirect, titled "${title}", its whole text and no script`, async ({
      page,
      baseURL,
    }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.request().redirectedFrom()).toBeNull();
      expect(page.url()).toBe(new URL(path, baseURL).href);
      await expect(page).toHaveTitle(`${title} — Krate`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      // the last section arrived with the first: the whole document is in the page itself
      await expect(
        page.getByRole("heading", { level: 2, name: "Contact" }),
      ).toBeVisible();
      // every [placeholder] filled, and the contact address one a reader can write to
      await expect(page.locator("main")).not.toContainText(/\[[^\]]+\]/);
      await expect(
        page.locator('main a[href="mailto:support@krate.si"]').last(),
      ).toHaveText("support@krate.si");
      expect(await page.locator("script").count()).toBe(0);
      await expect(
        page.getByRole("link", { name: "Krate" }).first(),
      ).toHaveAttribute("href", "/");
      const legal = page.getByRole("navigation", { name: "Legal" });
      await expect(legal.getByRole("link", { name: title })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(legal.locator(`a[href="${other}"]`)).toBeVisible();
    });

  test("the privacy policy says what Meta's WhatsApp terms and the DPDP Act ask of it", async ({
    page,
  }) => {
    await page.goto("/privacy");
    const main = page.getByRole("main");
    for (const words of [
      // Meta's terms for the WhatsApp Business Platform: no WhatsApp data trains or improves an AI model.
      "We never use WhatsApp messages, or any data that comes from them, to train or improve AI models",
      // the lead's way out, and the record that keeps it
      "Reply STOP to any WhatsApp message",
      // who decides about a lead's data, and the law that says so
      "the developer is the Data Fiduciary and we are its Data Processor",
      "Digital Personal Data Protection Act, 2023",
      "the Data Protection Board of India",
      // the service providers that receive personal data
      "Meta Platforms, which delivers WhatsApp messages",
      "Supabase, which holds our database",
      "our AI model provider",
      "our voice provider",
    ])
      await expect(main).toContainText(words);
  });

  test("the terms make the business the Data Fiduciary and link the privacy policy", async ({
    page,
  }) => {
    await page.goto("/terms");
    const main = page.getByRole("main");
    await expect(main).toContainText(
      "You are the Data Fiduciary for your leads’ data, and we are your Data Processor",
    );
    await expect(
      main.getByRole("link", { name: "privacy policy" }),
    ).toHaveAttribute("href", "/privacy");
  });
});

test("the landing page's footer opens each legal page", async ({ page }) => {
  for (const { path, title } of PAGES) {
    await page.goto("/");
    await page
      .getByRole("contentinfo")
      .getByRole("link", { name: title })
      .click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  }
});
