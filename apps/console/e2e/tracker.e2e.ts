// The tracker page (docs/tracker/index.html), in a real browser, served the way AGENTS.md → The loop, step 6 publishes
// it: next to ROADMAP.md, STATE.md, parse.js, published.txt and the records.md `bun run records` prints from
// docs/decisions-in-force/ and docs/rule-changes/. It shows every decision and rule change, and names a records.md
// that is missing or empty instead of showing none. FILENAME: *.e2e.ts, so `bun test` leaves it alone.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const ROOT = join(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const lineOf = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f !== "README.md")
    .map((f) => read(join(dir, f)).trim());

/** Serves the page at http://tracker.test/ with `records` as its records.md (none when undefined); nothing else loads. */
async function open(page: Page, records: string | undefined) {
  const files: Record<string, [string, string]> = {
    "index.html": [read("docs/tracker/index.html"), "text/html"],
    "parse.js": [read("docs/tracker/parse.js"), "text/javascript"],
    "ROADMAP.md": [read("ROADMAP.md"), "text/markdown"],
    "STATE.md": [read("STATE.md"), "text/markdown"],
    "published.txt": ["abc1234 on 2026-10-14\n", "text/plain"],
    ...(records === undefined
      ? {}
      : { "records.md": [records, "text/markdown"] as [string, string] }),
  };
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const file = url.host === "tracker.test" && files[url.pathname.slice(1)];
    return file
      ? route.fulfill({ body: file[0], contentType: file[1] })
      : url.host === "tracker.test"
        ? route.fulfill({ status: 404, body: "" })
        : route.abort();
  });
  await page.goto("http://tracker.test/index.html");
}

test("the tracker page shows every decision and every rule change the records hold", async ({
  page,
}) => {
  const decisions = lineOf("docs/decisions-in-force");
  const older = read("STATE.md")
    .split("## Rule changes")[1]
    ?.split("\n## ")[0]
    ?.split("\n")
    .filter((l) => l.startsWith("- "));
  const rules = new Set([...lineOf("docs/rule-changes"), ...(older ?? [])]);
  const records = execFileSync("bun", ["scripts/records.ts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  await open(page, records);
  await expect(page.locator("#decsum")).toHaveText(
    `Show ${decisions.length} decisions`,
  );
  await expect(page.locator("#rcsum")).toHaveText(
    `Show ${rules.size} rule changes`,
  );
  await expect(page.locator("#error")).toBeHidden();
  // Newest first: the first decision shown is the one in the newest-named file.
  const newest = readdirSync(join(ROOT, "docs/decisions-in-force"))
    .filter((f) => f !== "README.md")
    .sort()
    .at(-1);
  await page.locator("#decsum").click();
  await expect(page.locator("#decisions li").first()).toContainText(
    read(`docs/decisions-in-force/${newest}`)
      .trim()
      .replace(/^- /, "")
      .replace(/\*\*/g, "")
      .replace(/`/g, "")
      .slice(0, 40),
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
