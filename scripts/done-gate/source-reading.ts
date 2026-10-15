// For the done rules (rules.ts): does an added test line read source code as text? A test shows what the code does,
// never what it says. A line reads code when it reads a file (readFileSync, readFile, createReadStream, Bun.file, or
// an import of a path held in a name, with options) in a test whose added lines name a source path, or when it
// imports a code file with options (`with { type: "text" }`, `type: "file"`, which hands over the path to read, or
// any other: code imported to run needs none). A data file (a fixture, .json, .sql, .csv, .toml, .yml, .txt) may be
// read, unless the same words name a code file. Comments count for nothing. What still gets past it is listed in
// docs/done-gate.md → The done gate (the detail of STATE.md's done-gate row).

import { uncommented } from "./code-text";
import type { Added } from "./diff";

// A string literal naming source code: a src/ path, or a file ending .ts/.tsx/.js/.jsx.
export const SOURCE_PATH =
  /["'`](?:[^"'`\n]*\/)?(?:src(?:\/[^"'`\n]*)?|[^"'`\n]+\.[cm]?[jt]sx?)["'`]/;
const CODE_FILE = /["'`][^"'`\n]*\.[cm]?[jt]sx?["'`]/;
const DATA = /fixture|\.(json|sql|csv|toml|ya?ml|txt)\b/;
const READ =
  /\b(readFileSync|readFile|createReadStream|Bun\.file)\s*\(|\bimport\s*\(\s*[\w$.]+\s*,/;
const LITERAL = String.raw`(["'\x60][^"'\x60\n]*["'\x60])`;
// An import with options: `from "<path>" with {`, `import "<path>" assert {`, or `import("<path>", …`.
const IMPORT_WITH = new RegExp(
  String.raw`(?:\bfrom|^\s*import)\s*${LITERAL}\s*(?:with|assert)\s*\{|\bimport\s*\(\s*${LITERAL}\s*,`,
  "g",
);

/** PURE: words naming only a data file, and no code file beside it. */
const data = (code: string) => DATA.test(code) && !CODE_FILE.test(code);

/**
 * PURE: does the added test line at `i` read source code as text? `namesSource`: the change's added lines in its
 * file name a source path outside an import.
 */
export function readsCode(added: Added[], i: number, namesSource: boolean) {
  const a = added[i];
  if (!a) return false;
  let code = uncommented(a.text);
  if (namesSource && READ.test(code) && !data(code)) return true;
  // The formatter puts a long `import(` call's first argument on the line below it.
  const next = added[i + 1];
  if (
    /\bimport\s*\(\s*$/.test(code) &&
    next?.file === a.file &&
    next.line === a.line + 1
  )
    code += uncommented(next.text);
  return [...code.matchAll(IMPORT_WITH)].some(([, from, call]) => {
    const path = from ?? call ?? "";
    return SOURCE_PATH.test(path) && !data(path);
  });
}
