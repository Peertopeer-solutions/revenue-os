// The marketing site's build. `bun run build` (apps/www's "vite build" script) runs with
// cwd pinned to apps/www, so the workspace-installed vite does it; never `bunx vite`,
// which would fetch one over the network. It must emit a bundled component app that
// carries the hero copy, and ship the security headers Cloudflare Pages reads from
// dist/_headers (public/_headers, copied by the build).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBookingClient } from "../src/lib/booking";

const WWW_DIR = resolve(import.meta.dir, "..");
// What a real build writes to apps/www/dist, written to a folder of this run's own: vite empties its output folder
// as it starts, so a folder shared with another test run (the gate runs four whole suites at once) could be emptied,
// or have files deleted from under its build, while this run checks it.
const DIST_DIR = mkdtempSync(join(tmpdir(), "www-dist-"));
afterAll(() => rmSync(DIST_DIR, { recursive: true, force: true }));
// The hero headline — the one string that proves the component
// tree, not just an empty shell, made it into the bundle.
const HERO = "Turn property enquiries into qualified site visits.";
// Plausible's script and event host (README → analytics): the test build sets no
// script, so the bundle can't name it. A proxy or custom domain changes it here too.
const PLAUSIBLE = "https://plausible.io";
// The site's one public address (README → Publishing) and each built page's path there.
const SITE = "https://krate.si";
const PAGES = {
  "index.html": "/",
  "privacy.html": "/privacy",
  "terms.html": "/terms",
};

// The headers a _headers file gives one path: a path line, then its indented
// "Name: value" lines; # starts a comment.
function headersFor(file: string, path = "/*") {
  const out: Record<string, string> = {};
  let current = "";
  for (const line of file.split("\n")) {
    if (/^\s*(#|$)/.test(line)) continue;
    if (!/^\s/.test(line)) current = line.trim();
    else if (current === path) {
      const at = line.indexOf(":");
      out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
  }
  return out;
}

// The host the booking client really calls, seen through a fetch that records it.
async function bookingHost() {
  let url = "";
  const client = createBookingClient({
    username: "demo",
    eventSlug: "demo",
    fetch: async (u) => {
      url = String(u);
      return Response.json({});
    },
  });
  await client.fetchSlots("UTC").catch(() => {});
  return new URL(url).origin;
}

describe("apps/www builds into a bundled component app with its security headers", () => {
  // One build for both tests, so either can run alone; the first checks it succeeded.
  let built = false;
  let out = "";
  beforeAll(() => {
    try {
      out = execFileSync(
        process.execPath,
        ["run", "build", "--outDir", DIST_DIR, "--emptyOutDir"],
        { cwd: WWW_DIR, stdio: "pipe", timeout: 240_000 },
      ).toString();
      built = true;
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      out = `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? String(err)}`;
    }
  }, 260_000);

  test("vite build succeeds and emits a JS bundle carrying the hero copy", () => {
    expect(
      built,
      `\`bun run build\` must succeed in apps/www (vite build). Output:\n${out}`,
    ).toBe(true);

    // Vite default output: a static shell + hashed assets under dist/assets.
    expect(
      existsSync(resolve(DIST_DIR, "index.html")),
      "vite build must emit dist/index.html",
    ).toBe(true);
    const assetsDir = resolve(DIST_DIR, "assets");
    const jsFiles = existsSync(assetsDir)
      ? readdirSync(assetsDir).filter((f) => f.endsWith(".js"))
      : [];
    expect(
      jsFiles.length,
      "dist/assets must contain a bundled JS asset (the component app)",
    ).toBeGreaterThan(0);

    // The bundled app must carry the hero copy — proof the tree built.
    const heroInBundle = jsFiles.some((f) =>
      readFileSync(resolve(assetsDir, f), "utf8").includes(HERO),
    );
    expect(
      heroInBundle,
      "the bundled JS must contain the hero headline copy",
    ).toBe(true);
  });

  test("dist/_headers lets pages use only the site, Cal.com and Plausible, and no site frame them", async () => {
    const file = resolve(DIST_DIR, "_headers");
    expect(existsSync(file), "the build must ship dist/_headers").toBe(true);
    const headers = headersFor(readFileSync(file, "utf8"));
    const directives = (headers["content-security-policy"] ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name);
    // A browser obeys a directive's first copy: a repeat could hide a looser one.
    const names = directives.map(([name]) => name);
    expect(new Set(names).size, "no directive repeats").toBe(names.length);
    // Exactly this policy, so any loosening is a deliberate edit here: each host only
    // where the page needs it, data: only for the paper grain and the fonts vite
    // inlines, no 'unsafe-inline' or 'unsafe-eval', and no site may frame the page.
    const cal = await bookingHost();
    expect(
      Object.fromEntries(
        directives.map(([name, ...sources]) => [name, sources]),
      ),
    ).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", PLAUSIBLE],
      "connect-src": ["'self'", cal, PLAUSIBLE],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'", "data:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
    });
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("each page names its krate.si address, robots.txt and sitemap.xml send search engines there, and the pages.dev copies stay out of search", () => {
    const read = (file: string) =>
      readFileSync(resolve(DIST_DIR, file), "utf8");
    for (const [file, path] of Object.entries(PAGES))
      expect(
        read(file).match(/<link rel="canonical" href="([^"]*)"/)?.[1],
        `${file}'s canonical address`,
      ).toBe(new URL(path, SITE).href);
    expect(
      read("index.html").match(
        /<meta property="og:url" content="([^"]*)"/,
      )?.[1],
    ).toBe(`${SITE}/`);

    const robots = read("robots.txt")
      .split("\n")
      .map((l) => l.trim());
    expect(robots).toContain("User-agent: *");
    expect(robots, "nothing is closed to search engines").not.toContain(
      "Disallow: /",
    );
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    expect(
      [...read("sitemap.xml").matchAll(/<loc>([^<]*)<\/loc>/g)].map(
        (m) => m[1],
      ),
    ).toEqual(Object.values(PAGES).map((path) => new URL(path, SITE).href));

    // The project's pages.dev address and each preview's own serve the same pages: only krate.si is indexed.
    for (const host of [
      "https://:project.pages.dev/*",
      "https://:version.:project.pages.dev/*",
    ])
      expect(headersFor(read("_headers"), host), host).toEqual({
        "x-robots-tag": "noindex",
      });
  });
});
