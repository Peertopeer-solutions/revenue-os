// Reads ROADMAP.md and STATE.md. The one copy of "what is current", shared by the tracker page
// (index.html), the agent hooks (scripts/cycle.ts) and their tests. Plain JavaScript with no
// imports so the browser can load it as is; types are in parse.d.ts.

export const STATUSES = ["Works", "Tests only", "Partial", "Stub", "Missing"];
export const passedOk = (v) => /^\d{4}-\d{2}-\d{2}/.test(v || "");
// A file saved with Windows line endings, or with an invisible byte-order mark first, reads the same.
const lf = (md) => md.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
// An item's text as people retype it (a branch's description, a PR's first line): letter case, Markdown marks,
// quotes and extra spaces don't count.
export const plain = (s) =>
  s
    .replace(/[`*_~"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// A "Blocked by" value as meant: struck-through text, Markdown marks, quotes, wrapping brackets,
// trailing punctuation and a note ("(note)", or after ";", ",", ":", a dash or a spaced hyphen)
// removed, in lower case. A leading dash stays: "— the Meta keys" names a blocker.
function bare(v) {
  let s = v
    .replace(/<!--.*?-->/g, "")
    .replace(/(?<=\S)[.!?]\s+\S.*$/, "")
    .replace(/~~.*?~~/g, "")
    .replace(/[`*_"'“”‘’]/g, "")
    .toLowerCase();
  for (let was; was !== s; ) {
    was = s;
    s = s
      .trim()
      .replace(/[.,;:!?…]+$/, "")
      .replace(/^\((.*)\)$|^\[(.*)\]$/, "$1$2")
      .replace(/\s+\([^()]*\)$/, "")
      .replace(/(?<=\S)(?:\s*[;,:—–]|\s+-+(?:\s|$)).*$/, "");
  }
  return s.replace(/\s+/g, " ");
}
const MEANS_NOTHING =
  /^(nothing|none|nil|n\/?a|no|no blockers?|not blocked|unblocked|clear|[—–-]*)$/;

export function sections(md) {
  const out = {};
  let cur = null;
  for (const line of md.split("\n")) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      cur = h[1].trim();
      out[cur] = [];
      continue;
    }
    if (cur) out[cur].push(line);
  }
  return out;
}

export function parseRoadmap(md) {
  const slices = [];
  const problems = [];
  for (const part of lf(md).split(/^## /m).slice(1)) {
    const lines = part.split("\n");
    if (lines[0].startsWith("Side track:")) continue;
    const head = lines[0].match(/^Slice (\d+):\s*(.+)$/);
    if (!head) {
      problems.push(
        `Unknown section heading "## ${lines[0]}": use "## Slice N: title" or "## Side track: title"`,
      );
      continue;
    }
    const s = { n: +head[1], title: head[2].trim(), items: [] };
    for (const l of lines.slice(1)) {
      const f = l.match(
        /^(Status|Goal|Proof|Blocked by|Proof passed):\s*(.*)$/,
      );
      if (f) {
        s[f[1]] = f[2].trim();
        continue;
      }
      if (l.startsWith("Seen by Devesh:")) {
        problems.push(
          `Slice ${s.n}: the field "Seen by Devesh:" is now "Proof passed:"`,
        );
        continue;
      }
      const it = l.match(
        /^- \[([ x])\] (.+?) \((agent|Devesh)\)(?: · evidence: (.+))?\s*$/,
      );
      if (it) {
        s.items.push({
          done: it[1] === "x",
          text: it[2],
          owner: it[3],
          evidence: it[4] || "",
        });
        if (it[1] === "x" && !it[4])
          problems.push(`Slice ${s.n}: "${it[2]}" is ticked without evidence`);
        continue;
      }
      if (/^- \[/.test(l))
        problems.push(
          `Slice ${s.n}: checklist line not in the expected shape: "${l.trim()}"`,
        );
      else if (l.trim())
        problems.push(
          `Slice ${s.n}: line not understood (fields and items must each stay on one line): "${l.trim()}"`,
        );
    }
    for (const k of ["Status", "Goal", "Proof", "Blocked by", "Proof passed"])
      if (!(k in s)) problems.push(`Slice ${s.n} is missing its "${k}:" line`);
    if (
      s.Status &&
      !["not started", "in progress", "proof ready", "done"].includes(s.Status)
    )
      problems.push(`Slice ${s.n} has an unknown status "${s.Status}"`);
    // Only the exact word unblocks (currentSlice). Anything else that means "nothing" would park the
    // slice quietly, so say so; any other text is a real blocker, even "Nothing but …" or "— …".
    const b = s["Blocked by"];
    if (b !== undefined && b !== "nothing" && MEANS_NOTHING.test(bare(b)))
      problems.push(
        `Slice ${s.n}: "Blocked by: ${b}" counts as blocked; write exactly "Blocked by: nothing" or name the blocker`,
      );
    if (s.Status === "done" && !passedOk(s["Proof passed"]))
      problems.push(`Slice ${s.n} says done but "Proof passed" has no date`);
    const open = s.items.filter((i) => !i.done).length;
    if (s.Status === "done" && open)
      problems.push(
        `Slice ${s.n} says done but ${open} item${open === 1 ? " is" : "s are"} not ticked`,
      );
    slices.push(s);
  }
  if (!slices.length) problems.push("No slices found in ROADMAP.md");
  return { slices, problems };
}

const list = (sec, h) =>
  (sec[h] || []).filter((l) => /^- /.test(l)).map((l) => l.slice(2));

// The records.md `bun run records` prints from docs/decisions-in-force/ and docs/rule-changes/, newest first.
export function parseRecords(md) {
  const sec = sections(lf(md));
  const heads = ["Decisions in force", "Rule changes"];
  return {
    decisions: list(sec, heads[0]),
    ruleChanges: list(sec, heads[1]),
    problems: heads
      .filter((h) => !(h in sec))
      .map(
        (h) =>
          `records.md: missing the "## ${h}" heading (publish the output of \`bun run records\`)`,
      ),
  };
}

export function parseState(md) {
  md = lf(md);
  // Line 1 decides who merges, so only the exact words count; a comment may follow after a space.
  const phase = (md.match(/^PHASE: (SETUP|LIVE)(?=\s|$)/) || [])[1] || "?";
  const sec = sections(md);
  const problems = [];
  const table = (sec["What works today"] || [])
    .filter((l) => /^\|/.test(l))
    .map((l) =>
      l
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map((c) => c.trim().replace(/\\\|/g, "|")),
    );
  for (const c of table)
    if (c.length !== 4)
      problems.push(
        `STATE.md: a table row has ${c.length} columns, expected 4: "${c.join(" | ")}"`,
      );
  const rows = table.filter(
    (c) =>
      c.length === 4 && c[0] !== "Area" && !/^-+$/.test(c[0].replace(/:/g, "")),
  );
  if (phase === "?")
    problems.push(
      `STATE.md: line 1 must be "PHASE: SETUP" or "PHASE: LIVE", not "${md.split("\n")[0]}"`,
    );
  for (const h of ["What works today", "Waiting on Devesh"])
    if (!(h in sec))
      problems.push(`STATE.md: missing the "## ${h}" heading (exact wording)`);
  for (const r of rows)
    if (!STATUSES.includes(r[2]))
      problems.push(`STATE.md: unknown status "${r[2]}" for "${r[1]}"`);
  const checks = (l) => {
    const m = l.match(/^- \[([ x])\] (.+)$/);
    return m ? { done: m[1] === "x", text: m[2] } : null;
  };
  const waiting = (sec["Waiting on Devesh"] || []).map(checks).filter(Boolean);
  // The rule changes recorded before docs/rule-changes/ held one file per record (scripts/records.ts).
  const ruleChanges = list(sec, "Rule changes");
  if (!rows.length)
    problems.push('STATE.md: the "What works today" table is empty or missing');
  return { phase, rows, waiting, ruleChanges, problems };
}

// The rule at the top of ROADMAP.md: the lowest-numbered slice that is not done, not proof ready,
// and not blocked. A slice is blocked unless its line reads exactly "Blocked by: nothing".
export const currentSlice = (slices) =>
  slices
    .filter(
      (s) =>
        s.Status !== "done" &&
        s.Status !== "proof ready" &&
        s["Blocked by"] === "nothing",
    )
    .sort((a, b) => a.n - b.n)[0];

export const nextItem = (slice) =>
  slice?.items.find((i) => !i.done && i.owner === "agent");
