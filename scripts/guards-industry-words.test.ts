// The industry-word guard `bun run guards` runs (scripts/guards/industry-words.ts): no industry's words in the engine,
// the senders, the database package or the worker. Each case runs the real scripts/guards.sh in a throwaway git repo
// holding the files; the other guards find nothing there to fail. The planted files are never run, only read by the
// guard.
import { afterAll, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const GUARDS = join(import.meta.dir, "guards.sh");
const REPO = join(import.meta.dir, "..");
const CORE = [
  "packages/harness/src",
  "packages/channels/src",
  "packages/db/src",
  "services/worker/src",
];
const BANNER = "guard industry words ·";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function guards(
  files: Record<string, string>,
  { git = true, copy = [] as string[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "guards-industry-"));
  dirs.push(dir);
  for (const d of copy) cpSync(join(REPO, d), join(dir, d), { recursive: true });
  const all = { "docs/patterns/none.md": "# Pattern: none yet\n", ...files };
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  if (git)
    for (const args of [
      ["init", "-q"],
      ["add", "."],
    ])
      expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
  const r = spawnSync("bash", [GUARDS], { cwd: dir, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  const at = out.indexOf(BANNER);
  const own = at < 0 ? "" : (out.slice(at).split(/\n(?=guard )/)[0] ?? "");
  return { code: r.status, out, own };
}

it("passes the four core folders as this change leaves them", () => {
  const { own } = guards({}, { copy: CORE });
  expect(own).toMatch(/^guard industry words ·[^\n]*\n {2}PASS \(\d+ files read\)/);
}, 30_000);

it("fails each listed word planted in a core folder, however it is spelled, naming its file and line", () => {
  const planted = [
    "site visit",
    "site_visit_booked",
    "Site-Visit",
    "SITE_VISIT",
    "bookSiteVisit",
    "real estate",
    "realEstate",
    "2BHK",
    "RERA",
    "possession",
    "carpet_area",
    "homeBuyer",
    "home buyers",
    "apartments",
    "Villa",
  ];
  const { code, own } = guards({
    "packages/harness/src/tools/x.ts": planted
      .map((w) => `export const a = "${w}";`)
      .join("\n"),
    "packages/channels/src/x.ts": "// a villa, in a comment\n",
    "packages/db/src/x.sql": "-- the site visit table\n",
    "services/worker/src/x.ts": "\nconst kind = 'site_visit';\n",
  });
  for (const [i, w] of planted.entries())
    expect(own).toContain(
      `packages/harness/src/tools/x.ts:${i + 1}: "${w.replace(/^2/, "")}"`,
    );
  expect(own).toContain('packages/channels/src/x.ts:1: "villa"');
  expect(own).toContain('packages/db/src/x.sql:1: "site visit"');
  expect(own).toContain('services/worker/src/x.ts:2: "site_visit"');
  expect(own).toContain("FAIL — industry words");
  expect(code).toBe(1);
}, 30_000);

it("passes ordinary programming words, channel and provider names, and words that only hold a listed one", () => {
  const { code, own } = guards({
    "packages/harness/src/x.ts": [
      "const schema = { type: 'object', properties: {} };",
      "const rows = [[1], [2]].flat();",
      "const bearerAuth = 'x'; // not RERA",
      "const visitor = 'a site visitor';",
      "const villain = 'parasite';",
      "const SITE_VISITOR = 'x';",
      "const rbhk = 'bhk in small letters is no acronym';",
      "const possessive = 'x';",
      "const providers = ['WhatsApp', 'Vapi', 'LiveKit', 'Twilio'];",
    ].join("\n"),
  });
  expect(own).toContain("PASS (1 file read)");
  expect(code).toBe(0);
}, 30_000);

it("reads only the core folders: seed packs, settings, tests and the console may name an industry", () => {
  const word = "export const kind = 'site_visit';\n";
  const { code, own } = guards({
    "supabase/seeds/pack.sql": "-- site visit\n",
    "packages/shared/src/x.ts": word,
    "apps/console/src/x.ts": word,
    "services/worker/test/x.test.ts": word,
    "packages/harness/test/x.test.ts": word,
    "packages/harness/src/clean.ts": "export const kind = 'appointment';\n",
  });
  expect(own).toContain("PASS (1 file read)");
  expect(code).toBe(0);
}, 30_000);

it("fails loudly outside a git checkout, where it can list no files: nothing was checked", () => {
  const { code, own } = guards(
    { "packages/db/src/x.ts": "export const x = 1;\n" },
    { git: false },
  );
  expect(own).toMatch(
    /^guard industry words ·[^\n]*\n {2}FAIL — industry words: [^\n]*nothing was checked/,
  );
  expect(code).toBe(1);
}, 30_000);
