// The tracker page (docs/tracker/index.html), in a real browser, served the way AGENTS.md → The loop, step 6 publishes
// it: next to ROADMAP.md, STATE.md, parse.js, published.txt and the records.md `bun run records` prints from
// docs/decisions-in-force/ and docs/rule-changes/. It shows every decision and rule change, newest first, and names a
// records.md that is missing or empty instead of showing none. FILENAME: *.e2e.ts, so `bun test` leaves it alone.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const ROOT = join(__dirname, "..", "..", "..");
const PAGE = ["index.html", "parse.js"].map((f) => [f, `docs/tracker/${f}`]);
const records = () =>
  execFileSync("bun", ["scripts/records.ts"], { cwd: ROOT, encoding: "utf8" });
const bullets = (md: string, section: string) =>
  (md.split(`## ${section}\n`)[1] ?? "")
    .split("\n## ")[0]
    ?.split("\n")
    .filter((l) => l.startsWith("- ")) ?? [];

/** Serves the page at http://tracker.test/ with `md` as its records.md (none when undefined); nothing else loads. */
async function open(page: Page, md: string | undefined) {
  const files = new Map<string, { path?: string; body?: string }>([
    ...PAGE.map(([f, p]) => [f, { path: join(ROOT, p) }] as const),
    ["ROADMAP.md", { path: join(ROOT, "ROADMAP.md") }],
    ["STATE.md", { path: join(ROOT, "STATE.md") }],
    ["published.txt", { body: "abc1234 on 2026-10-14\n" }],
    ...(md === undefined ? [] : [["records.md", { body: md }] as const]),
  ]);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.host !== "tracker.test") return route.abort();
    const file = files.get(url.pathname.slice(1));
    return file
      ? route.fulfill({
          ...file,
          contentType: url.pathname.endsWith(".js")
            ? "text/javascript"
            : undefined,
        })
      : route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://tracker.test/index.html");
}

test("the tracker page shows every decision and every rule change the records hold, newest first", async ({
  page,
}) => {
  const md = records();
  const decisions = bullets(md, "Decisions in force");
  const rules = bullets(md, "Rule changes");
  // One decision per file in the folder, and at least one rule change per file in its folder.
  const files = (dir: string) =>
    readdirSync(join(ROOT, dir)).filter((f) => f !== "README.md").length;
  expect(decisions.length).toBe(files("docs/decisions-in-force"));
  expect(rules.length).toBeGreaterThanOrEqual(files("docs/rule-changes"));
  await open(page, md);
  await expect(page.locator("#decsum")).toHaveText(
    `Show ${decisions.length} decisions`,
  );
  await expect(page.locator("#rcsum")).toHaveText(
    `Show ${rules.length} rule changes`,
  );
  await expect(page.locator("#error")).toBeHidden();
  await page.locator("#decsum").click();
  await expect(page.locator("#decisions li")).toHaveCount(decisions.length);
  // The newest decision first, as written (its Markdown marks rendered away).
  await expect(page.locator("#decisions li").first()).toContainText(
    (decisions[0] ?? "")
      .slice(2)
      .replace(/\*\*|`/g, "")
      .slice(0, 38),
  );
});

test("the tracker page names a records.md that is missing or empty, never showing no records", async ({
  page,
}) => {
  await open(page, undefined);
  await expect(page.locator("#error")).toHaveText(
    "Could not load records.md. Publish it next to this page.",
  );
  await page.unrouteAll();
  await open(page, "");
  await expect(page.locator("#error")).toContainText(
    'records.md: missing the "## Decisions in force" heading',
  );
});
