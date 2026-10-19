// The tests a Proof line cites by name, run by name in the proved checkout (`bun test <file> -t <name>`): each must
// still exist under that name and pass. A rename, a deletion or a failure fails the step that cites it.

import { sh } from "./scratch";

const REGEX = /[.*+?^${}()|[\]\\]/g;

/**
 * What was seen when every test of `file` named in `names` ran alone and passed; else an error naming each that didn't.
 * The tests run with the PATH and home folder only, plus `env` (a test that signs in needs the local stack's settings).
 */
export function namedTestsPass(
  root: string,
  file: string,
  names: string[],
  env: Record<string, string | undefined> = {},
) {
  const bad = names.flatMap((name) => {
    const r = sh(
      root,
      ["bun", "test", file, "-t", name.replace(REGEX, "\\$&")],
      env,
    );
    const ran = /\b1 pass\b/.test(r.out) && /\b0 fail\b/.test(r.out);
    return r.status === 0 && ran
      ? []
      : [
          `"${name}" (exit ${r.status}): ${r.out.trim().split("\n").slice(-3).join(" / ")}`,
        ];
  });
  if (bad.length)
    throw new Error(
      `in ${file}, ${bad.length} cited test(s) did not run alone and pass: ${bad.join("; ")}`,
    );
  return `the ${names.length} test(s) it cites in ${file} each ran alone and passed`;
}
