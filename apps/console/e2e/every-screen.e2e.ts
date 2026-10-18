// Every screen in the console's route list, opened by the dev login on the seeded workspace against the real local
// stack. The list is the route manifest itself (src/routes.tsx, read by route-list.ts), so a screen added there is
// opened here with nothing else to change. Each screen must stay at its address, finish loading and show no error
// (a page error, a console error, a failed or refused request, the error screen, a data block in its error state),
// and show its demo rows: no data block left loading or empty, and every table with at least one row. A screen
// whose address takes a value (a transcript's conversation) is opened through a link to it on the screens already
// opened, as a person reaches it; the check fails, naming it, when no screen links to it. FILENAME: *.e2e.ts, so
// `bun test` leaves it alone.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { signIn } from "./sign-in";

const RouteList = z
  .array(z.object({ path: z.string().min(1), label: z.string().min(1) }))
  .min(1);

function routeList() {
  const out = execFileSync("bun", [resolve(__dirname, "route-list.ts")], {
    encoding: "utf8",
  });
  return RouteList.parse(JSON.parse(out));
}

/** PURE: the address a person reaches a route at, as a pattern any value of its `:name` parts matches. */
const addressOf = (orgId: string, path: string) =>
  new RegExp(`^/o/${orgId}/${path.replace(/:[^/]+/g, "[^/]+")}$`);

/** What this screen did wrong, as people would see it. */
async function problemsOn(page: Page, label: string): Promise<string[]> {
  const found: string[] = [];
  const settled = page.locator('[data-state="loading"]');
  await expect(settled)
    .toHaveCount(0, { timeout: 15_000 })
    .catch(() => found.push(`${label}: still loading after 15 seconds`));
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => found.push(`${label}: still fetching after 10 seconds`));
  for (const [what, selector] of [
    ["an error state", '[data-state="error"]'],
    ["an empty state, so its demo rows are missing", '[data-state="empty"]'],
  ] as const) {
    const texts = await page.locator(selector).allInnerTexts();
    for (const text of texts) found.push(`${label}: ${what}: "${text}"`);
  }
  if (await page.getByRole("heading", { name: "Something went wrong" }).count())
    found.push(`${label}: the error screen`);
  const tables = await page
    .locator("table")
    .evaluateAll((all) =>
      all.map((t) => t.querySelectorAll("tbody tr").length),
    );
  for (const [i, rows] of tables.entries())
    if (rows === 0)
      found.push(
        `${label}: table ${i + 1} has no rows, so its demo rows are missing`,
      );
  return found;
}

test("every screen in the console's route list opens with its demo rows and no error", async ({
  page,
}) => {
  const routes = routeList();
  let screen = "signing in";
  const problems: string[] = [];
  page.on("pageerror", (e) =>
    problems.push(`${screen}: page error: ${e.message}`),
  );
  page.on("console", (m) => {
    if (m.type() === "error")
      problems.push(`${screen}: console error: ${m.text()}`);
  });
  // A request the browser cancelled (net::ERR_ABORTED: the check moved to the next screen while it ran) is no
  // failure; one the API never answered or refused is. A screen whose data never came stays loading or errs, above.
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    if (why !== "net::ERR_ABORTED")
      problems.push(
        `${screen}: request failed: ${r.method()} ${r.url()} (${why})`,
      );
  });
  page.on("response", (r) => {
    if (r.status() >= 400)
      problems.push(
        `${screen}: HTTP ${r.status()}: ${r.request().method()} ${r.url()}`,
      );
  });

  const orgId = await signIn(page);
  const links = new Set<string>();
  // Screens with a value in their address go last, once every link to them has been seen.
  const ordered = [
    ...routes.filter((r) => !r.path.includes(":")),
    ...routes.filter((r) => r.path.includes(":")),
  ];
  for (const route of ordered) {
    screen = `${route.label} (${route.path})`;
    const address = addressOf(orgId, route.path);
    const target = route.path.includes(":")
      ? [...links].find((link) => address.test(link))
      : `/o/${orgId}/${route.path}`;
    if (!target) {
      problems.push(
        `${screen}: no screen links to it, so the check has no demo row to open it with`,
      );
      continue;
    }
    await test.step(`open ${screen} at ${target}`, async () => {
      await page.goto(target);
      problems.push(...(await problemsOn(page, screen)));
      const at = new URL(page.url()).pathname;
      if (at !== target) problems.push(`${screen}: sent on to ${at}`);
      const hrefs = await page
        .locator("a[href]")
        .evaluateAll((all) => all.map((a) => a.getAttribute("href") ?? ""));
      for (const href of hrefs) links.add(new URL(href, page.url()).pathname);
    });
  }

  expect(problems).toEqual([]);
});
