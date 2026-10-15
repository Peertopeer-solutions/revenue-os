// The exact code in a checkout (tracked and untracked files, minus ignored ones) as a tree id, with its diff
// from main (the lines git saw move marked, moved.ts) and, for each export the diff adds, the files that use it.

import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
  exportsOf,
  listedExports,
  statementAt,
  uncommented,
} from "./code-text";
import { type Added, parseDiff } from "./diff";
import {
  candidatesOf,
  leadsTo,
  modulePath,
  reExportsOf,
  STAR_FROM,
  usesExport,
} from "./export-users";
import { git } from "./git";
import { COLOURS, DETECT, withMoved } from "./moved";
import { stateDir } from "./store";

export type Snap = {
  repo: string;
  tree: string;
  from: string; // the commit the change starts from: where it left the base (the tree itself when there is no diff)
  files: string[];
  deleted: string[];
  added: Added[];
  removed: Added[];
  users: Map<string, string[]>;
};

/**
 * The exact code in the worktree (tracked + untracked, minus ignored) as a tree id, plus its diff from where
 * HEAD left `base`. Without a `base`, origin/main, or HEAD in a checkout that has none. With `head`, the code of
 * that commit instead, against where it left `base` (origin/main without one): read as data, never checked out.
 */
export function snapshot(
  repo: string,
  withDiff = true,
  base?: string,
  head?: string,
): Snap {
  if (head) {
    const tree = git(repo, ["rev-parse", "--verify", `${head}^{tree}`]);
    if (!withDiff) return NONE(repo, tree);
    const from = git(repo, ["merge-base", head, base ?? "origin/main"]);
    return analyse(
      repo,
      tree,
      from,
      git(repo, [...DIFF, from, head]),
      git(repo, [...MOVED, from, head], {}, true),
      (args) =>
        git(repo, [...GREP, ...args, tree], {}, true)
          .split("\0")
          .filter(Boolean)
          .map((l) => l.slice(tree.length + 1)), // "<tree>:<path>"
      (f) => git(repo, ["cat-file", "blob", `${tree}:${f}`], {}, true),
    );
  }
  const index = join(stateDir(repo), `index-${process.pid}`);
  const real = git(repo, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  if (existsSync(real)) {
    copyFileSync(real, index); // reuse git's file-stat cache: `add -A` stays fast
    // With the index's own age, which tells git what to re-read: a same-size edit in the second it was written.
    const written = Math.floor(statSync(real).mtimeMs / 1000);
    utimesSync(index, written, written);
  }
  const env = { GIT_INDEX_FILE: index };
  try {
    git(repo, ["add", "-A"], env);
    const tree = git(repo, ["write-tree"], env);
    if (!withDiff) return NONE(repo, tree);
    const from = base
      ? git(repo, ["merge-base", "HEAD", base])
      : git(repo, ["merge-base", "HEAD", "origin/main"], {}, true) || "HEAD";
    return analyse(
      repo,
      tree,
      from,
      git(repo, [...DIFF, "--cached", from], env),
      git(repo, [...MOVED, "--cached", from], env, true),
      (args) =>
        git(repo, [...GREP, "--cached", ...args], env, true)
          .split("\0")
          .filter(Boolean),
      (f) => {
        try {
          return readFileSync(join(repo, f), "utf8");
        } catch {
          return ""; // e.g. a symlink to a folder
        }
      },
    );
  } finally {
    rmSync(index, { force: true });
  }
}

const NONE = (repo: string, tree: string): Snap => ({
  repo,
  tree,
  from: tree,
  files: [],
  deleted: [],
  added: [],
  removed: [],
  users: new Map(),
});
// The change's own .gitattributes must not hide it (`*.ts -diff`, `binary`) nor run a program on it, so the
// attributes come from the empty tree, and no text conversion runs.
const NO_ATTRIBUTES = "--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // the empty tree
export const GREP = [NO_ATTRIBUTES, "-c", "core.quotePath=off", "grep", "-z"];
const OPTIONS = [
  "--no-textconv",
  "--unified=0",
  "--no-renames",
  "--no-ext-diff",
];
const DIFF = [
  NO_ATTRIBUTES,
  "-c",
  "core.quotePath=off",
  "diff",
  "--no-color",
  ...OPTIONS,
];
// The same diff again, coloured to show which lines moved; its text is never read. Should it fail, no line is moved.
const MOVED = [
  NO_ATTRIBUTES,
  ...COLOURS,
  "-c",
  "core.quotePath=off",
  "diff",
  ...DETECT,
  ...OPTIONS,
];

/**
 * The diff's files and lines (those the coloured run shows moved marked), and for each export it adds, the files that
 * use it. `grepIn(options)` runs `git grep` with them over the code being judged and lists the files it names;
 * `readFile` reads one of them.
 */
function analyse(
  repo: string,
  tree: string,
  from: string,
  diff: string,
  coloured: string,
  grepIn: (args: string[]) => string[],
  readFile: (f: string) => string,
): Snap {
  const parsed = parseDiff(diff);
  const { files, deleted } = parsed;
  const marked = withMoved(coloured, parsed);
  const { removed } = marked;
  const texts = new Map<string, string>();
  let held: Set<string> | undefined; // the files in the tree: nothing outside it is read, an ignored file neither
  const read = (f: string) => {
    held ??= new Set(
      git(repo, ["ls-tree", "-r", "-z", "--name-only", tree]).split("\0"),
    );
    if (!texts.has(f)) texts.set(f, held.has(f) ? readFile(f) : "");
    return texts.get(f) ?? "";
  };
  // A name added inside a multi-line export list the change did not open is an export of its own (code-text.ts).
  const lists = new Map<string, ReturnType<typeof listedExports>>();
  const added = marked.added.map((a) => {
    if (
      !/^\s*(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*(?:\}.*)?$/.test(
        a.text,
      )
    )
      return a;
    const list = lists.get(a.file) ?? listedExports(read(a.file));
    lists.set(a.file, list);
    const at = list.get(a.line);
    return at &&
      !marked.added.some((o) => o.file === a.file && o.line === at.open)
      ? { ...a, within: at.stmt }
      : a;
  });
  // Files holding a string: only candidates, usesExport decides.
  const grep = (s: string, word = false) =>
    grepIn(["-lIF"].concat(word ? ["-w"] : []).concat(["-e", s]));
  const moduleAt = (spec: string, f: string) =>
    candidatesOf(spec, f).find((c) => read(c) !== "");
  /** The names `f` exports, those it passes on with `export *` included; never its default. */
  const namesOf = (f: string, seen = new Set<string>()): string[] => {
    if (seen.has(f)) return [];
    seen.add(f);
    const lines = read(f)
      .split("\n")
      .map((text, i) => ({ file: f, line: i + 1, text }));
    return lines
      .flatMap((_, i) => exportsOf(statementAt(lines, i).code))
      .flatMap((n) => {
        if (!n.startsWith("* from ")) return n === "default" ? [] : [n];
        const next = moduleAt(n.slice(7), f);
        return next ? namesOf(next, seen) : [];
      });
  };
  let stars: [string, string[]][] | undefined; // files that `export * from`, and from where
  let namespaced: string[] | undefined; // files that may `import * as`
  const found = new Map<string, string[]>(); // "file name" → files using the export
  /** The files using `name`, which `file` exports: by importing it, through barrels, or through a file passing it on. */
  const usersOf = (file: string, name: string): string[] => {
    const key = `${file} ${name}`;
    const known = found.get(key);
    if (known) return known;
    found.set(key, []); // a ring of files passing it on adds nothing
    let users: string[];
    if (name.startsWith("* from ")) {
      // `export * from` passes on every name of its module: each a use when imported through this file. A module
      // it can't read (a package name or alias), or one passing on no name the rules check (types alone), is let
      // through.
      const target = moduleAt(name.slice(7), file);
      const names = target ? namesOf(target) : [];
      users = names.length ? names.flatMap((n) => usersOf(file, n)) : [file];
    } else {
      stars ??= grep("export *").map((f) => [
        f,
        [...uncommented(read(f)).matchAll(STAR_FROM)].map((m) => m[1] ?? ""),
      ]);
      const reach = [file]; // file, then every barrel that re-exports it, however deep
      for (const to of reach)
        for (const [b, specs] of stars)
          if (!reach.includes(b) && specs.some((s) => leadsTo(s, b, to)))
            reach.push(b);
      namespaced ??= grep("* as");
      // A default export's importers name its module, or its package for a package's entry file.
      const words =
        name === "default"
          ? [
              modulePath(file).split("/").at(-1) ?? "",
              file.match(
                /^packages\/([^/]+)\/src\/index\.[cm]?[jt]sx?$/,
              )?.[1] ?? "",
            ].filter(Boolean)
          : [name];
      const barrels = reach.slice(1);
      users = [
        ...new Set([...words.flatMap((w) => grep(w, true)), ...namespaced]),
      ].flatMap((f) => [
        ...(usesExport(read(f), f, file, name, barrels) ? [f] : []),
        ...reExportsOf(read(f), f, file, name, barrels).flatMap((as) =>
          usersOf(f, as),
        ),
      ]);
    }
    users = [...new Set(users)];
    found.set(key, users);
    return users;
  };
  const users = new Map<string, string[]>();
  for (const [i, { file }] of added.entries())
    for (const name of exportsOf(statementAt(added, i).code))
      users.set(`${file} ${name}`, usersOf(file, name));
  return { repo, tree, from, files, deleted, added, removed, users };
}
