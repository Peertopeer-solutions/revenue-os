// The company-filter guard: every SQL query the product runs names its company, the second fence our rules require on
// top of the database's own per-company rules (AGENTS.md → Conventions, docs/patterns/drizzle-query.md). The database's
// rules hide another company's rows from a query run through withOrg; the filter in the SQL still holds the day a query
// runs without them (as the database's owner, or with a rule switched off by mistake).
//
// It reads every `.query(` call in the code files git lists under apps/, services/, packages/ and scripts/, leaving out
// tests and the scripts that are not the product's queries (NOT_PRODUCT below). The SQL must be one string or template
// literal written at the call, with no ${…} piece in it, since a piece could add a table or an `or true`; anything else
// fails, because its filter can't be seen. In that SQL, at each query level (the statement, and each select, insert,
// update, delete, with, values or table in parentheses), every table read, updated or deleted from needs one
// and-condition of its own level's where clause, or of its own inner or left join's on clause:
//   - `x.org_id = $n` or `$n = x.org_id` (either side may carry ::uuid), x being the table's alias or, with no alias,
//     its name; a bare `org_id = $n` counts only when the level reads from one thing;
//   - `(x.org_id = $n or x.org_id is null)`, either way round, for the shared template tables (TEMPLATES) only;
//   - for orgs, `x.id = $n`.
// A clause with an `or` at its own level counts for nothing, nor does a link such as `a.org_id = b.org_id`. Every insert
// lists org_id (orgs: id) among its columns, and an insert's `on conflict … do update` has org_id in its conflict key or
// its own where clause. Tables in app. and pgboss. (the job queue's own tables), functions and common table expressions
// are not company tables; a table in any other schema fails, and so do profiles and platform_operators, which have no
// org_id. A read that must look across companies goes through an app.* security-definer function, as app.due_org_ids
// does.
//
// It also holds six tables to one writer each (ONE_WRITER): an insert into tasks, audit_log, org_members, conversations,
// messages or agent_assignments fails anywhere but the file that owns the table in packages/db (createTask; audit; the
// audited member grant; openConversation and addMessage; setAssignment), so every task is for a lead and every audit
// row, access grant, conversation, message and choice of the role that works a lead is written one way. An update or
// delete of conversations, messages or agent_assignments (EVERY_WRITE) fails there too, so a conversation is finished
// one way (finishConversation) and an assignment changes one way. A write's target is always the real table,
// whatever a common table expression is named, and a merge statement fails anywhere in the SQL.
//
// Known limits: it proves the SQL names a company parameter, not that $n holds the request's company (the tests that
// run with the database's rules off cover that); SQL in database functions is not read; a `query` reached by
// destructuring or by a bracket (tx["query"]) is not seen; it tells a regex from a division by the token before it,
// and a .tsx file's text by its line, so code written to fool that can hide a call. Proven by
// scripts/guards-company-filter.test.ts.

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";

const SCOPE = /^(?:apps|services|packages|scripts)\/.+\.[cm]?[jt]sx?$/;
const TESTS =
  /\.d\.[cm]?ts$|[._](?:test|spec)\.[cm]?[jt]sx?$|\.e2e\.[cm]?[jt]sx?$|^(?:apps|services|packages)\/[^/]+\/(?:tests?|e2e|__tests__)\//;
// Scripts whose SQL is not the product's: the done gate and the guards, which run none; the proof steps, which check as
// the database's owner that something did NOT happen; the local tools that set the database up as its owner; and
// evals.ts, which finds its company by slug before it knows one (and so finds none today: STATE.md → What works today).
const NOT_PRODUCT =
  /^scripts\/(?:done-gate|guards\/|proof\/|(?:seed|dev-login|db-reset|app-service-login|evals)\.ts$)/;
const TEMPLATES = new Set(["agents", "workflows", "eval_scenarios"]); // the only tables whose org_id may be empty
const NO_ORG_ID = new Set(["profiles", "platform_operators"]); // public tables without an org_id column
const KNOWN_SCHEMA = /^(?:app|pgboss)\./;
// The only file that may insert into each of these tables (scripts and tests outside SCOPE aside).
const ONE_WRITER: Record<string, string> = {
  tasks: "packages/db/src/tasks.ts",
  audit_log: "packages/db/src/audit.ts",
  org_members: "packages/db/src/orgs.ts",
  conversations: "packages/db/src/conversations.ts",
  messages: "packages/db/src/conversations.ts",
  agent_assignments: "packages/db/src/assignments.ts",
};
// Tables whose every write, not just an insert, belongs to their one writer.
const EVERY_WRITE = new Set(["conversations", "messages", "agent_assignments"]);
const HOLE = "\u0001"; // a ${…} in a template literal
const ODD = "\u0002"; // SQL this guard would read differently from the database
const HOW =
  "FAIL — company filter: give every read, update and delete of a company table x.org_id = $n as an and-condition of its own where clause (or its own join's on clause), (x.org_id = $n or x.org_id is null) for the shared template agents, workflows and eval scenarios, and x.id = $n for orgs; list org_id among every insert's columns; write the whole SQL as one literal at the call, values as $n parameters. See docs/patterns/drizzle-query.md";

function fail(lines: string[], why = HOW): never {
  for (const l of [...lines, why]) console.log(`  ${l}`);
  process.exit(1);
}

// ── The code side: each `.query(` call and the SQL literal it is given ──

type Tok = { v: string; at: number; end: number; sql?: string; text?: string };
const REGEX_AFTER = new Set(
  "return typeof instanceof in of new delete void throw case do else yield await".split(
    " ",
  ),
);
const WORD = /[\w$]+/y;

/** A file's code tokens, comments skipped; a string or template literal carries its text as `sql`, ${…} as holes.
 * `open` is true when the file ends inside a template literal or a comment, as this lexer reads it. */
function lex(src: string): { toks: Tok[]; open: boolean } {
  const toks: Tok[] = [];
  let i = 0;
  let open = false;
  let last = ""; // the last token, which tells a regex from a division
  const push = (v: string, at: number, sql?: string) => {
    const t: Tok = { v, at, end: i, sql };
    toks.push(t);
    last = v;
    return t;
  };
  /** The character a backslash escapes, a newline or tab kept as a space. */
  const escaped = () => {
    const c = src[i + 1] ?? "";
    i += 2;
    return "ntrvbf0".includes(c) ? " " : c;
  };
  /** A '…' or "…" string's text; undefined for a quote the line doesn't close, as in JSX text (Don't). */
  const quoted = () => {
    const q = src[i++];
    let text = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\n") return undefined;
      text += src[i] === "\\" ? escaped() : src[i++];
    }
    i++;
    return text;
  };
  const template = () => {
    let text = "";
    for (i++; i < src.length && src[i] !== "`"; ) {
      if (src[i] === "\\") text += escaped();
      else if (src.startsWith("${", i)) {
        const from = i;
        i += 2;
        code(true);
        text += ` ${HOLE} ${src.slice(from, i).replace(/[^\n]/g, "")}`; // its lines kept, for line numbers
      } else text += src[i++];
    }
    if (i >= src.length) open = true;
    i++;
    return text;
  };
  /** Steps past a regex literal; false, staying put, for a slash the line doesn't close, as in JSX (</p>). */
  const regex = () => {
    const start = i;
    let inClass = false;
    for (i++; i < src.length && src[i] !== "\n"; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === "[") inClass = true;
      else if (src[i] === "]") inClass = false;
      else if (src[i] === "/" && !inClass) break;
    }
    if (src[i] !== "/") i = start;
    else for (i++; /[a-z]/i.test(src[i] ?? ""); ) i++;
    return i > start;
  };
  /** A slash after this token divides, or (after "<") closes a JSX tag; anywhere else it starts a regex. */
  const divides = () =>
    /^[\w$]/.test(last)
      ? !REGEX_AFTER.has(last)
      : [")", "]", '"', "'", "`", "/re/", "<"].includes(last);
  function code(inHole: boolean): void {
    let depth = 0;
    while (i < src.length) {
      const c = src[i] as string;
      const at = i;
      WORD.lastIndex = i;
      const word = WORD.exec(src)?.[0];
      if (/\s/.test(c)) i++;
      else if (src.startsWith("//", i)) {
        const eol = src.indexOf("\n", i);
        i = eol < 0 ? src.length : eol;
      } else if (src.startsWith("/*", i)) {
        const close = src.indexOf("*/", i + 2);
        if (close < 0) open = true;
        i = close < 0 ? src.length : close + 2;
      } else if (c === '"' || c === "'") {
        const text = quoted();
        if (text === undefined) i = at + 1;
        push(c, at, text);
      } else if (c === "`") {
        const t = push(c, at);
        t.sql = template();
        t.end = i;
        last = c;
      } else if (c === "/" && !divides() && regex())
        push("/re/", at).text = src.slice(at, i);
      else if (word) {
        i += word.length;
        push(word, at);
      } else if (c === "}" && inHole && depth === 0) {
        i++;
        return;
      } else {
        if (c === "{") depth++;
        if (c === "}") depth--;
        const arrow = src.startsWith("=>", i);
        i += arrow ? 2 : 1;
        push(arrow ? "=>" : c, at);
      }
    }
  }
  code(false);
  return { toks, open };
}

type Call = { at: number; sql?: string; problem?: string };
const NOT_A_CALL =
  "query is used other than as a direct call, so its SQL can't be checked: call it as x.query(`…`, [values])";
const NOT_WRITTEN =
  "the SQL is not written at this call, so its company filter can't be checked: write it as one literal in x.query(…)";

/** The `.query(` calls: where each starts, and its SQL when its first argument is a literal and nothing more. */
function calls(toks: Tok[]): Call[] {
  const found: Call[] = [];
  toks.forEach((t, k) => {
    if (t.v !== "." || toks[k + 1]?.v !== "query") return;
    // x.req.query(…) is Hono's reader of a web address's query string, not SQL
    if (toks[k - 1]?.v === "req" && toks[k - 2]?.v === ".") return;
    let j = k + 2;
    if (toks[j]?.v === "<") {
      for (let depth = 0; j < toks.length; j++) {
        if (toks[j]?.v === "<") depth++;
        else if (toks[j]?.v === ">" && --depth === 0) break;
      }
      j++;
    }
    if (toks[j]?.v === "!") j++;
    if (toks[j]?.v === "?" && toks[j + 1]?.v === ".") j += 2;
    if (toks[j]?.v !== "(") {
      found.push({ at: t.at, problem: NOT_A_CALL });
      return;
    }
    const arg = toks[j + 1];
    if (!arg || arg.v === ")") return; // no argument, so no SQL
    let n = j + 2;
    while ((toks[n]?.at ?? arg.end) < arg.end) n++; // past the holes' own tokens
    const after = toks[n]?.v;
    found.push(
      arg.sql !== undefined && (after === "," || after === ")")
        ? { at: arg.at, sql: arg.sql }
        : { at: t.at, problem: NOT_WRITTEN },
    );
  });
  return found;
}

// ── The SQL side: each table a query reads, changes or inserts into, and the filter it carries ──

type S = { t: string; at: number; name?: boolean; quoted?: boolean };
const SQL_TOKEN =
  /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|(?:[a-z_][\w$]*|"(?:[^"]|"")*")(?:\s*\.\s*(?:[a-z_][\w$]*|"(?:[^"]|"")*"|\*))*|\$\d+|\d+(?:\.\d+)?|::|[<>=!~+\-*/%^|&#@?]+|\S/gi;
const PART = /"((?:[^"]|"")*)"|([^\s."]+)/g;
const PUBLIC = /^(?:[^.]+\.)?public\./; // public.x, or <database>.public.x

/** The SQL's tokens: comments and strings dropped (one holding a hole stays a hole), names unquoted and lowercased.
 * A dollar quote, an E'…' string (backslash escapes) or a nested block comment becomes ODD: the database reads each
 * differently from this tokenizer. */
function sqlTokens(sql: string): S[] {
  const out: S[] = [];
  for (const m of sql.matchAll(SQL_TOKEN)) {
    const [t] = m;
    const at = m.index ?? 0;
    const prev = out.at(-1);
    if (/^(?:--|\/\*|')/.test(t)) {
      if (t.includes(HOLE)) out.push({ t: HOLE, at: at + t.indexOf(HOLE) });
      else if (t.startsWith("/*") && t.slice(2).includes("/*"))
        out.push({ t: ODD, at });
      else if (t.startsWith("'"))
        out.push({
          t: prev?.name && prev.t === "e" && prev.at + 1 === at ? ODD : "'",
          at,
        });
    } else if (/^[a-z_"]/i.test(t)) {
      const parts = [...t.matchAll(PART)].map(([, q, plain]) =>
        q === undefined ? (plain ?? "").toLowerCase() : q.replace(/""/g, '"'),
      );
      const quoted = parts.length === 1 && t.startsWith('"');
      out.push(
        t.includes("$") && !quoted
          ? { t: ODD, at }
          : { t: parts.join("."), at, name: true, quoted },
      );
    } else out.push({ t: t === "$" ? ODD : t.toLowerCase(), at });
  }
  return out;
}

const QUERY = [
  "select",
  "insert",
  "update",
  "delete",
  "with",
  "values",
  "table",
];
const STATEMENTS = new Set([
  ...QUERY,
  ..."( begin start commit end rollback abort savepoint release".split(" "),
]);
const WHERE_END =
  "group order limit offset having window returning for fetch".split(" ");
const ON_END = [
  ...WHERE_END,
  ..."where join left right inner full cross natural ,".split(" "),
];
const NOT_ALIAS = new Set([
  ...ON_END,
  ..."on using set union intersect except values select default lateral as and or not do with tablesample".split(
    " ",
  ),
]);

type Ref = {
  table: string;
  q: string; // its alias, or its name
  at: number;
  verb: string;
  on?: [number, number];
  cols?: string[];
};
type Cond = { q: string; col: string; template?: boolean };

/** The problems in one call's SQL in `file`, each at its offset in the SQL text. */
function problemsIn(sql: string, file: string): { at: number; what: string }[] {
  const T = sqlTokens(sql);
  const out: { at: number; what: string }[] = [];
  const odd = T.find((t) => t.t === ODD);
  if (odd)
    return [
      {
        at: odd.at,
        what: "SQL this guard would read differently from the database (a dollar quote, an E'…' string or a nested comment): write it plainly",
      },
    ];
  for (const t of T)
    if (t.t === HOLE)
      out.push({
        at: t.at,
        what: `a \${…} piece in the SQL, which can add tables or conditions this guard can't see: write the whole SQL at the call, values as $n parameters`,
      });
  const merge = T.find((t) => t.t === "merge" && t.name && !t.quoted);
  if (merge)
    out.push({
      at: merge.at,
      what: "a merge statement, which this guard can't check: use select, insert, update or delete with the company filter",
    });
  const is = (i: number | undefined, v: string) =>
    i !== undefined && T[i]?.t === v;
  const kw = (i: number | undefined, ...words: string[]) =>
    words.some((w) => is(i, w)) && !T[i as number]?.quoted;
  const close: number[] = [];
  const parent: number[] = []; // the innermost "(" around each token (a ")" belongs to its own), or -1
  const open: number[] = [];
  T.forEach((t, i) => {
    parent[i] = open.at(-1) ?? -1;
    if (t.t === "(") open.push(i);
    else if (t.t === ")" && open.length) {
      const o = open.pop() as number;
      close[o] = i;
      parent[i] = o;
    }
  });
  for (const o of open) close[o] = T.length;
  const closeOf = (o: number) => (o === -1 ? T.length : (close[o] ?? T.length));
  const level = (o: number) => o === -1 || (is(o, "(") && kw(o + 1, ...QUERY));
  /** The tokens directly inside group `o` (the whole SQL for -1), between `from` and `to`. */
  const inside = (o: number, from = o + 1, to = closeOf(o)) => {
    const top: number[] = [];
    for (let i = from; i < to; i++) if (parent[i] === o) top.push(i);
    return top;
  };
  const words = (p: number[]) =>
    p
      .map((i) => T[i]?.t)
      .join(" ")
      .replace(/ :: uuid\b/g, "");

  /** The filter one and-condition gives: x.org_id = $n, $n = x.org_id, or x.id = $n (orgs). */
  const condition = (p: number[]): Cond | undefined => {
    const m =
      /^(?:(\S+)\.)?(org_id|id) = \$\d+$/.exec(words(p)) ??
      /^\$\d+ = (?:(\S+)\.)?(org_id|id)$/.exec(words(p));
    return m
      ? { q: (m[1] ?? "").replace(PUBLIC, ""), col: m[2] as string }
      : undefined;
  };
  /** The template group (x.org_id = $n or x.org_id is null), either way round. */
  const template = (g: number): Cond | undefined => {
    const top = inside(g);
    const ors = top.filter((i) => kw(i, "or"));
    if (ors.length !== 1) return;
    const k = top.indexOf(ors[0] as number);
    const sides = [top.slice(0, k), top.slice(k + 1)];
    for (const [a = [], b = []] of [sides, [...sides].reverse()]) {
      const c = condition(a);
      const isNull = /^(?:(\S+)\.)?org_id is null$/.exec(words(b));
      if (c?.col === "org_id" && isNull && c.q === (isNull[1] ?? ""))
        return { ...c, template: true };
    }
  };
  /** The filters a where or on clause gives: its and-conditions, none at all when it has an or or a hole. */
  const conjuncts = (from: number, to: number, o: number): Cond[] => {
    const top = inside(o, from, to);
    if (top.some((i) => kw(i, "or") || is(i, HOLE))) return [];
    const pieces: number[][] = [[]];
    let between = false; // the and of `between a and b` joins, never splits
    for (const i of top) {
      if (kw(i, "between")) between = true;
      if (kw(i, "and") && !between) pieces.push([]);
      else {
        if (kw(i, "and")) between = false;
        pieces.at(-1)?.push(i);
      }
    }
    return pieces.flatMap((p) => {
      const [g] = p;
      if (p.length === 1 && g !== undefined && is(g, "("))
        return template(g) ?? conjuncts(g + 1, closeOf(g), g);
      return condition(p) ?? [];
    });
  };

  // A common table expression's name means it, not a table, from its body's end (its start, when recursive) on.
  const ctes: { name: string; from: number; to: number }[] = [];
  const levels = [-1, ...T.flatMap((_, i) => (level(i) ? [i] : []))];
  for (const o of levels) {
    const D = inside(o);
    D.forEach((i, k) => {
      if (!kw(i, "with")) return;
      const recursive = kw(D[k + 1], "recursive");
      for (let m = k + (recursive ? 2 : 1); ; m += 2) {
        const name = T[D[m] as number]?.t ?? "";
        m += is(D[m + 1], "(") ? 2 : 1; // past its column list, if any
        if (!kw(D[m], "as")) break;
        m++;
        while (kw(D[m], "not", "materialized")) m++;
        const body = D[m];
        if (body === undefined || !is(body, "(")) break;
        const to = D.slice(m).find((d) => is(d, ";")) ?? closeOf(o);
        ctes.push({ name, from: recursive ? body : closeOf(body), to });
        if (!is(D[m + 1], ",")) break;
      }
    });
  }
  const cte = (name: string, at: number) =>
    ctes.some((c) => c.name === name && c.from < at && at < c.to);

  for (const o of levels) {
    const arms: number[][] = [[]];
    const D = inside(o);
    D.forEach((i, k) => {
      const set = kw(D[k - 1], "union", "intersect", "except");
      if (is(i, ";") || kw(i, "union", "intersect", "except")) arms.push([]);
      else if (!(set && kw(i, "all", "distinct"))) arms.at(-1)?.push(i);
    });
    for (const arm of arms) checkArm(o, arm);
  }

  /** One select, insert, update or delete at level `o`, given as its tokens at that level. */
  function checkArm(o: number, all: number[]) {
    const last = all.at(-1);
    const spanEnd =
      last === undefined ? 0 : is(last, "(") ? closeOf(last) + 1 : last + 1;
    const conflict = all.findIndex(
      (i, k) => kw(i, "on") && kw(all[k + 1], "conflict"),
    );
    // nothing after `on conflict` is a table; its do update is checked below
    const A = conflict < 0 ? all : all.slice(0, conflict);
    const armEnd = conflict < 0 ? spanEnd : (all[conflict] as number);
    const first = A[0];
    if (
      first !== undefined &&
      !(STATEMENTS.has(T[first]?.t ?? "") && !T[first]?.quoted)
    )
      out.push({
        at: T[first]?.at ?? 0,
        what: `a ${T[first]?.t} statement, which this guard can't check: use select, insert, update or delete with the company filter`,
      });
    for (const i of A)
      if (kw(i, "table"))
        out.push({
          at: T[i]?.at ?? 0,
          what: "a TABLE x read, which can't carry the company filter: write select … from x where x.org_id = $n",
        });
    const next = (k: number, ends: string[]) =>
      A.slice(k + 1).find((i) => kw(i, ...ends)) ?? armEnd;
    const refs: Ref[] = [];
    let items = 0; // the things this level reads from: tables, functions, subqueries, common table expressions
    let where: [number, number] | undefined;

    /** Reads the table names after A[k] (from, join, update, into, using or a from list's comma); returns where it
     * stopped. */
    const tables = (k: number): number => {
      const word = T[A[k] as number]?.t;
      const verb =
        word === "update"
          ? "updated"
          : word === "into"
            ? "inserted into"
            : kw(A[k - 1], "delete")
              ? "deleted from"
              : "read";
      const kind = kw(A[k - 1], "outer") ? A[k - 2] : A[k - 1];
      let m = k + 1;
      for (;;) {
        while (kw(A[m], "only", "lateral")) m++;
        const i = A[m];
        const t = i === undefined ? undefined : T[i];
        if (i === undefined || !t || !(t.name || t.t === "(")) return m;
        let ref: Ref | undefined;
        m++;
        if (word !== "into") items++;
        const table = t.t.replace(PUBLIC, "");
        if (t.t === "(") {
          if (!level(i))
            out.push({
              at: t.at,
              what: "a parenthesized join, which this guard can't read: name each table after its own from or join",
            });
        } else if (is(A[m], "(") && word !== "into")
          m++; // a function: generate_series(…), app.user_orgs($1)
        else if (table.includes(".")) {
          if (!KNOWN_SCHEMA.test(table))
            out.push({
              at: t.at,
              what: `${table}, a table in a schema this guard doesn't know: use a public table, or an app.* function`,
            });
        } else if (t.t.includes(".") || verb !== "read" || !cte(table, i))
          ref = { table, q: table, at: t.at, verb }; // a write's target is the real table, whatever a CTE is named
        const after = T[A[m] as number];
        if (kw(A[m], "as")) {
          if (ref) ref.q = T[A[m + 1] as number]?.t ?? table;
          m += 2;
        } else if (after?.name && (after.quoted || !NOT_ALIAS.has(after.t))) {
          if (ref) ref.q = after.t;
          m++;
        }
        const list = A[m];
        const columns =
          list !== undefined && is(list, "(") && !level(list)
            ? list
            : undefined;
        if (word === "into") {
          if (ref)
            ref.cols =
              columns === undefined
                ? undefined
                : inside(columns).map((c) => T[c]?.t ?? "");
        } else if (columns !== undefined) m++; // the alias's column list: gs(n)
        if (
          ref &&
          word === "join" &&
          kw(A[m], "on") &&
          !kw(kind, "right", "full")
        )
          ref.on = [(A[m] as number) + 1, next(m, ON_END)];
        if (ref) refs.push(ref);
        if ((word !== "from" && word !== "using") || !is(A[m], ",")) return m;
        m++;
      }
    };

    let fromList = false; // inside a from list, where a comma after a join starts another table
    for (let k = 0; k < A.length; k++) {
      const i = A[k] as number;
      if (kw(i, "where") || kw(i, ...WHERE_END) || kw(i, "set", "values"))
        fromList = false;
      if (kw(i, "where") && !where) where = [i + 1, next(k, WHERE_END)];
      else if (is(i, ",") && fromList) k = tables(k) - 1;
      else if (
        (kw(i, "from") && !kw(A[k - 1], "distinct")) ||
        kw(i, "join") ||
        (kw(i, "update") && !kw(A[k - 1], "for", "key", "do")) ||
        (kw(i, "into") && kw(A[k - 1], "insert")) ||
        (kw(i, "using") && !is(A[k + 1], "("))
      ) {
        if (kw(i, "from", "join", "using")) fromList = true;
        k = tables(k) - 1;
      }
    }

    const filters = where ? conjuncts(where[0], where[1], o) : [];
    for (const r of refs) {
      const col = r.table === "orgs" ? "id" : "org_id";
      const named = r.q === r.table ? r.table : `${r.table} (as ${r.q})`;
      const owner = ONE_WRITER[r.table];
      if (
        owner &&
        owner !== file &&
        (r.verb === "inserted into" ||
          (r.verb !== "read" && EVERY_WRITE.has(r.table)))
      )
        out.push({
          at: r.at,
          what: `${r.verb === "inserted into" ? "inserts into" : r.verb === "updated" ? "updates" : "deletes from"} ${r.table}, which only ${owner} writes: call its function instead`,
        });
      if (r.verb === "inserted into") {
        if (!r.cols)
          out.push({
            at: r.at,
            what: `inserts into ${r.table} without a column list, so ${col} can't be seen: list the columns, ${col} among them`,
          });
        else if (!r.cols.includes(col))
          out.push({
            at: r.at,
            what: `inserts into ${r.table} without ${col} among its columns: list ${col} and give it the company's id`,
          });
        continue;
      }
      if (NO_ORG_ID.has(r.table)) {
        out.push({
          at: r.at,
          what: `${named} is ${r.verb}, a table with no org_id, so it can't carry the company filter: read it through an app.* security-definer function`,
        });
        continue;
      }
      const fits = (c: Cond) =>
        c.col === col &&
        (!c.template || TEMPLATES.has(r.table)) &&
        (c.q === r.q || (c.q === "" && items === 1));
      if (
        filters.some(fits) ||
        (r.on && conjuncts(r.on[0], r.on[1], o).some(fits))
      )
        continue;
      out.push({
        at: r.at,
        what:
          col === "id"
            ? `${named} is ${r.verb} without id = $n: add ${r.q}.id = $n to its where clause as an and-condition`
            : `${named} is ${r.verb} without its company: add ${r.q}.org_id = $n${TEMPLATES.has(r.table) ? ` (or (${r.q}.org_id = $n or ${r.q}.org_id is null) to read the shared templates too)` : ""} to its where clause as an and-condition`,
      });
    }

    // An insert's `on conflict … do update` changes the row already there: its key or its where must hold the company.
    const doAt = all.findIndex((i, k) => k > conflict && kw(i, "do"));
    const target = refs.find((r) => r.verb === "inserted into");
    if (conflict >= 0 && target && kw(all[doAt + 1], "update")) {
      const key = all[conflict + 2];
      const keyed =
        key !== undefined &&
        is(key, "(") &&
        inside(key).some((i) => kw(i, "org_id"));
      const w = all.findIndex((i, k) => k > doAt && kw(i, "where"));
      const wEnd = all.slice(w + 1).find((i) => kw(i, "returning")) ?? spanEnd;
      const guarded =
        w >= 0 &&
        conjuncts((all[w] as number) + 1, wEnd, o).some(
          (c) =>
            c.col === "org_id" &&
            !c.template &&
            [target.q, target.table, ""].includes(c.q),
        );
      if (!keyed && !guarded)
        out.push({
          at: T[all[conflict] as number]?.at ?? 0,
          what: `${target.table} is updated on conflict without its company: name org_id in the conflict's key, on conflict (org_id, …), or add ${target.q}.org_id = $n to the do update's where clause`,
        });
    }
  }
  return out;
}

// ── The files: what git lists under apps/, services/, packages/ and scripts/ ──

/** Runs git; asks once more when it answers nothing, as Bun's sync spawn can under load. Undefined when git fails. */
function git(...args: string[]): string | undefined {
  for (let n = 0; n < 2; n++) {
    const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) return undefined;
    if (r.stdout) return r.stdout;
  }
  return "";
}

console.log(
  "guard company filter · every SQL query the product runs names its company (org_id = $n), on top of the database's per-company rules",
);
const root = git("rev-parse", "--show-toplevel")?.trim();
if (!root)
  fail(
    [],
    "FAIL — company filter: git can't read this checkout, so nothing was checked",
  );
process.chdir(root);
const listed = git(
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
);
if (!listed)
  fail(
    [],
    `FAIL — company filter: ${listed === undefined ? "git ls-files failed" : "git listed no files"}, so nothing was checked`,
  );
const newlines = (text: string, at: number) =>
  text.slice(0, at).split("\n").length - 1;
const LOST = /\.\s*query\s*(?:<|\(|\?\.)/;
const problems: string[] = [];
let queries = 0;
let holding = 0;
for (const f of listed.split("\0")) {
  if (!SCOPE.test(f) || TESTS.test(f) || NOT_PRODUCT.test(f)) continue;
  const stat = lstatSync(f, { throwIfNoEntry: false });
  if (!stat) continue; // deleted, not yet staged
  if (!stat.isFile()) {
    problems.push(
      `${f}: a link, which this guard does not follow: make it a plain file`,
    );
    continue;
  }
  const src = readFileSync(f, "utf8");
  const { toks, open } = lex(src);
  if (open)
    problems.push(
      `${f}: ends inside a template literal or a comment as this guard reads it, so a query in it could be hidden: check its regex literals and JSX text`,
    );
  for (const t of toks)
    if (LOST.test(t.sql ?? t.text ?? ""))
      problems.push(
        `${f}:${newlines(src, t.at) + 1}: .query( inside a string, template or regex, which this guard can't tell from a call it lost its place over: build that text another way`,
      );
  const found = calls(toks);
  queries += found.length;
  if (found.length) holding++;
  for (const c of found) {
    const line = newlines(src, c.at) + 1;
    if (c.problem) problems.push(`${f}:${line}: ${c.problem}`);
    else
      for (const p of problemsIn(c.sql ?? "", f))
        problems.push(`${f}:${line + newlines(c.sql ?? "", p.at)}: ${p.what}`);
  }
}
if (problems.length) fail(problems);
console.log(
  `  PASS (${queries} quer${queries === 1 ? "y" : "ies"} in ${holding} file${holding === 1 ? "" : "s"})`,
);
