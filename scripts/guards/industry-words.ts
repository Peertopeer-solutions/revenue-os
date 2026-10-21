// The industry-word guard: no word of one industry in the core folders — the engine (packages/harness/src), the
// senders (packages/channels/src), the database package (packages/db/src) and the worker (services/worker/src) — so a
// role in any industry is rows, and a new one needs no change to them (docs/NORTH-STAR.md, shape rule 1; ROADMAP.md:
// "A role is rows, never code"). An industry's words live in seed packs and company settings, which the code reads.
//
// A word matches whole, in any letter case, with spaces, underscores or hyphens between its parts or none at all, so
// "site visit", site_visit, site-visit, SITE_VISIT and siteVisit all match, and with an "s" or "es" after it; a word
// inside a longer one (visitor, villain, parasite) does not, and a camel-case boundary counts as a word's edge. An
// acronym (BHK, RERA) matches in capitals only, so bearerAuth is not RERA. "property" and "flat" are not on the list:
// JSON Schema's `properties` and JavaScript's `flat()` would trip every core file. Channel and provider names
// (WhatsApp, Vapi, LiveKit) are not industry words. Every file git lists in those folders is read, comments included.
// Proven by scripts/guards-industry-words.test.ts.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";

const CORE = [
  "packages/harness/src",
  "packages/channels/src",
  "packages/db/src",
  "services/worker/src",
];
const WORDS = [
  "site visit",
  "real estate",
  "possession",
  "carpet area",
  "home buyer",
  "apartment",
  "villa",
];
const ACRONYMS = ["BHK", "RERA"];

const anyCase = (s: string) =>
  [...s].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
// A word's start: no letter before it, or a capital right after a small letter (camel case). Its end: an optional
// plural, then no small letter, nor a capital straight after a capital.
const START = "(?:(?<![A-Za-z])|(?<=[a-z])(?=[A-Z]))";
const END = "(?:[eE]?[sS])?(?![a-z])(?!(?<=[A-Z])[A-Z])";
const TERMS = new RegExp(
  [
    ...WORDS.map(
      (w) => `${START}${w.split(" ").map(anyCase).join("[ _-]*")}${END}`,
    ),
    ...ACRONYMS.map((a) => `(?<![A-Z])${a}(?:s)?(?![A-Z])`),
  ].join("|"),
  "g",
);
const HOW = `FAIL — industry words: the core folders (${CORE.join(", ")}) name no industry, so a role in any industry is rows. Move the word into a seed pack (supabase/seeds/) or the company's settings, and have the code read it from the role version (docs/NORTH-STAR.md, shape rule 1)`;

function fail(lines: string[], why = HOW): never {
  for (const l of [...lines, why]) console.log(`  ${l}`);
  process.exit(1);
}

function git(...args: string[]): string | undefined {
  for (let n = 0; n < 2; n++) {
    const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) return undefined;
    if (r.stdout) return r.stdout;
  }
  return "";
}

console.log(
  `guard industry words · no industry's words (${[...WORDS, ...ACRONYMS].join(", ")}) in the engine, the senders, the database package or the worker`,
);
const root = git("rev-parse", "--show-toplevel")?.trim();
if (!root)
  fail(
    [],
    "FAIL — industry words: git can't read this checkout, so nothing was checked",
  );
process.chdir(root);
const listed = git(
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  ...CORE,
);
if (listed === undefined)
  fail([], "FAIL — industry words: git ls-files failed, so nothing was checked");
// A checkout without the core folders has nothing to check; one that has them but whose files git didn't list would
// pass having read nothing.
if (!listed && CORE.some((d) => existsSync(d)))
  fail(
    [],
    "FAIL — industry words: git listed no files in the core folders, so nothing was checked",
  );
const problems: string[] = [];
let read = 0;
for (const f of listed.split("\0").filter(Boolean)) {
  const stat = lstatSync(f, { throwIfNoEntry: false });
  if (!stat) continue; // deleted, not yet staged
  if (!stat.isFile()) {
    problems.push(
      `${f}: a link, which this guard does not follow: make it a plain file`,
    );
    continue;
  }
  read++;
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((text, i) => {
      for (const m of text.matchAll(TERMS))
        problems.push(`${f}:${i + 1}: "${m[0]}"`);
    });
}
if (problems.length) fail(problems);
console.log(`  PASS (${read} file${read === 1 ? "" : "s"} read)`);
