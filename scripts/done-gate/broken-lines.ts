// Breaking a line on purpose: for guardrail, tenancy and money code (GUARDED), each line a change adds is broken in
// up to two ways, a condition on it flipped and the statement it starts removed, and at least one test must then fail
// (break-check.ts runs them). This file is the pure part: which files are in scope and how one line is broken.
//
// The code is read token by token (codeMask), never parsed: strings, template text, regexes and comments are blanked,
// so nothing inside them is ever flipped. A broken copy counts only when Bun's transpiler still reads it and what it
// gives differs from the original's: a copy that would not parse, or a break of a type alone, is dropped.

import { isTestFile } from "./test-run";

export type Kind = "guardrail" | "tenancy" | "money";

/**
 * Guardrail, tenancy and money code, by path (a path ending "/" names a folder); the first match decides the kind.
 * Only .ts and .tsx files, never a test.
 */
export const GUARDED: { path: string; kind: Kind | null }[] = [
  // The guard() pipeline every send and every tool's side effect passes, and the calling-hours check it uses.
  { path: "packages/harness/src/policies/", kind: "guardrail" },
  { path: "packages/harness/src/quiet-hours.ts", kind: "guardrail" },
  // The agent loop runs guard() before each tool's side effect and turns an approval-gated action into a human task.
  { path: "packages/harness/src/loop.ts", kind: "guardrail" },
  { path: "packages/harness/src/tool-call.ts", kind: "guardrail" },
  // The send doorways: guard() runs before the sender on every path (hard rail 5).
  { path: "packages/channels/src/", kind: "guardrail" },
  // The job handlers that send through those doorways, their only production callers.
  { path: "services/worker/src/handlers/place-call.ts", kind: "guardrail" },
  { path: "services/worker/src/handlers/send-wa.ts", kind: "guardrail" },
  // The one way those handlers send: the guard and the saved send in one transaction, then the provider (sendOnce).
  { path: "services/worker/src/sends.ts", kind: "guardrail" },
  // Each company's guardrail settings, as guard() reads them and as the admin-only API changes them.
  { path: "packages/db/src/guardrails.ts", kind: "guardrail" },
  {
    path: "services/worker/src/routes/guardrail-policies.ts",
    kind: "guardrail",
  },
  // withOrg (client.ts) sets the company the database's per-company rules see; every query here filters by company.
  { path: "packages/db/src/", kind: "tenancy" },
  // The sign-in token check that names the user, and the routes that check the user belongs to the company asked for.
  { path: "services/worker/src/auth.ts", kind: "tenancy" },
  // The worker's routes, and the line that puts sign-in in front of every one of them.
  { path: "services/worker/src/app.ts", kind: "tenancy" },
  { path: "services/worker/src/routes/", kind: "tenancy" },
  // Usage and its cost, recorded per company.
  { path: "packages/harness/src/meter.ts", kind: "money" },
];

/** PURE: the kind of guarded code a file is, if it is in scope. */
export const kindOf = (file: string): Kind | undefined =>
  /(?<!\.d)\.tsx?$/.test(file) && !isTestFile(file)
    ? (GUARDED.find((g) =>
        g.path.endsWith("/") ? file.startsWith(g.path) : file === g.path,
      )?.kind ?? undefined)
    : undefined;

// A "/" after one of these (or after nothing) starts a regex; after anything else it divides.
const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%<>~^]$/;
const KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|instanceof|yield|await)$/;

/**
 * PURE: the source with everything that is not code blanked to spaces (newlines kept, so offsets and lines match):
 * comments whole, and the inside of strings, template text and regexes. A template's `${…}` stays code, written
 * `$(…)` so its braces count as brackets.
 */
export function codeMask(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  /** The last few characters of code before `i`, spaces skipped. */
  const before = (i: number) => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k] ?? "")) k--;
    return out.slice(Math.max(0, k - 11), k + 1).join("");
  };
  const holes: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let template = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (template) {
      const from = i;
      while (i < src.length && src[i] !== "`" && !src.startsWith("${", i))
        i += src[i] === "\\" ? 2 : 1;
      blank(from, Math.min(i, src.length));
      if (src[i] === "`") {
        template = false;
        i++;
      } else if (i < src.length) {
        holes.push(depth++);
        out[i + 1] = "("; // a hole's braces read as brackets, never as a block
        template = false;
        i += 2;
      }
      continue;
    }
    if (c === "/" && (n === "/" || n === "*")) {
      const e = n === "/" ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : n === "/" ? e : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n")
        j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, src.length));
      i = j + 1;
    } else if (c === "`") {
      template = true;
      i++;
    } else if (
      c === "/" &&
      (BEFORE_REGEX.test(before(i)) ||
        KEYWORD_BEFORE.test(before(i)) ||
        before(i) === "")
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/")) {
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j += src[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, Math.min(j, src.length));
      i = j + 1;
    } else {
      if (c === "{") depth++;
      else if (c === "}" && --depth === holes.at(-1)) {
        holes.pop();
        out[i] = ")";
        template = true;
      }
      i++;
    }
  }
  return out.join("");
}

export type Break = {
  how: "flip" | "remove";
  /** The broken line as the copy has it (flip), or the first line of what was removed (remove). */
  shown: string;
  /** The whole file, broken. */
  text: string;
};

const FLIP: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  "<": ">=",
  ">=": "<",
  ">": "<=",
  "<=": ">",
  "&&": "||",
  "||": "&&",
  true: "false",
  false: "true",
  "!": "",
};
const FLIPPABLE = /===|!==|==|!=|&&|\|\||<=|>=|<|>|\btrue\b|\bfalse\b|!/g;

/** PURE: may the token found at `at` in the mask be flipped? Shifts, arrows, a type's `!` and the like may not. */
function flippable(mask: string, at: number, tok: string) {
  const prev = mask[at - 1] ?? "";
  const next = mask[at + tok.length] ?? "";
  if (tok === "<" || tok === "<=") return prev !== "<" && next !== "<";
  if (tok === ">" || tok === ">=")
    return !"=>-".includes(prev || " ") && next !== ">";
  if (tok === "!")
    return (
      next !== "=" &&
      !/[\w$)\]!]/.test(mask.slice(0, at).trimEnd().at(-1) ?? "")
    );
  return true;
}

/** PURE: the offset just past the bracket that closes the one at `open` in the mask, or -1. */
function closing(mask: string, open: number) {
  let d = 0;
  for (let k = open; k < mask.length; k++) {
    const c = mask[k] ?? "";
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c) && --d === 0) return k + 1;
  }
  return -1;
}

/** PURE: the offset just past the statement that starts at `start` in the mask, or -1 when it can't tell. */
function statementEnd(mask: string, start: number) {
  let d = 0;
  for (let k = start; k < mask.length; k++) {
    const c = mask[k] ?? "";
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) {
      if (--d < 0) return k; // the enclosing block closes: the statement ends before it
      // A block's "}" ends the statement when nothing but a ";" follows on its line, and the next line goes on with
      // neither else, catch or finally nor an operator carrying the expression on (`: null;` after an object).
      if (d === 0 && c === "}") {
        const rest = mask.slice(k + 1);
        const line = rest.split("\n")[0]?.trim() ?? "";
        if (line.startsWith(";")) return k + 2 + rest.indexOf(";");
        if (
          line ||
          /^(?:(?:else|catch|finally)\b|[).,?:=&|*/%<>])/.test(rest.trimStart())
        )
          continue;
        return k + 1;
      }
    } else if (c === ";" && d === 0) return k + 1;
  }
  return -1;
}

/**
 * PURE: up to two broken copies of `source` for its line `line` (from 1): the first condition on it flipped (or a
 * bare if/while condition, or a ternary's, negated), and the statement it starts removed (or, on a line holding
 * whole list items, a property or an argument, those items). Each copy parses and runs differently from the original.
 */
export function breaksOf(source: string, line: number, tsx = false): Break[] {
  const transpiler = new Bun.Transpiler({ loader: tsx ? "tsx" : "ts" });
  const out = (code: string) => {
    try {
      return transpiler.transformSync(code);
    } catch {
      return undefined;
    }
  };
  const original = out(source);
  const differs = (text: string) => {
    const t = out(text);
    return t !== undefined && t !== original;
  };
  const mask = codeMask(source);
  const lines = source.split("\n");
  const from = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
  const to = from + (lines[line - 1]?.length ?? 0);
  const at = (text: string) => text.split("\n")[line - 1] ?? "";
  const breaks: Break[] = [];

  // (a) flip: each flippable token on the line in turn, until one gives a copy that parses and runs differently.
  const swap = (s: number, e: number, by: string) =>
    source.slice(0, s) + by + source.slice(e);
  const flips: string[] = [];
  for (const m of mask.slice(from, to).matchAll(FLIPPABLE)) {
    const s = from + (m.index ?? 0);
    if (flippable(mask, s, m[0]))
      flips.push(swap(s, s + m[0].length, FLIP[m[0]] ?? m[0]));
  }
  const cond = mask.slice(from, to).match(/\b(?:if|while)\s*\(/);
  if (cond) {
    const open = from + (cond.index ?? 0) + cond[0].length - 1;
    const end = closing(mask, open);
    if (end > 0)
      flips.push(
        `${source.slice(0, open + 1)}!(${source.slice(open + 1, end - 1)})${source.slice(end - 1)}`,
      );
  }
  const q = mask.slice(from, to).search(/(?<![?.])\?(?![?.:])/);
  if (q >= 0) {
    const head = mask.slice(from, from + q);
    const s = Math.max(
      ...[/=(?![=>])/, /\(/, /\breturn\b/, /,/, /=>/, /:/].map((r) => {
        const all = [...head.matchAll(new RegExp(r.source, "g"))];
        const last = all.at(-1);
        return last ? (last.index ?? 0) + last[0].length : 0;
      }),
    );
    const c0 =
      from + s + (head.slice(s).length - head.slice(s).trimStart().length);
    const c1 = from + q;
    if (source.slice(c0, c1).trim())
      flips.push(
        `${source.slice(0, c0)}!(${source.slice(c0, c1).trimEnd()}) ${source.slice(c1)}`,
      );
  }
  const flip = flips.find(differs);
  if (flip) breaks.push({ how: "flip", shown: at(flip).trim(), text: flip });

  // (b) remove: the statement the line starts, kept as blank lines so later line numbers hold; else its list items.
  const first = from + (mask.slice(from, to).search(/\S/) >>> 0);
  const lead = mask.slice(first, to);
  const prev = mask.slice(0, first).trimEnd();
  let end = -1;
  if (
    first < to &&
    !/^(?:[)\]}.,?:]|else\b|case\b|default\b|catch\b|finally\b)/.test(lead) &&
    (prev === "" || /[;{}]$/.test(prev) || /(?:^|[^\w$])else$/.test(prev))
  )
    end = statementEnd(mask, first);
  else if (
    first < to &&
    /,\s*$/.test(lead) &&
    [...lead].reduce(
      (d, c) => d + ("([{".includes(c) ? 1 : ")]}".includes(c) ? -1 : 0),
      0,
    ) === 0
  )
    end = to;
  if (end > first) {
    const gone = source.slice(first, end);
    const text =
      source.slice(0, first) + gone.replace(/[^\n]/g, "") + source.slice(end);
    if (differs(text))
      breaks.push({
        how: "remove",
        shown: gone.split("\n")[0]?.trim() ?? "",
        text,
      });
  }
  return breaks;
}
