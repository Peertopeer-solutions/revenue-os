// What the verifier is handed when it starts: the roadmap item each checkout the session worked in builds, as
// ROADMAP.md on origin/main words it (found by the branch's description, which the building agent writes, so the
// description itself is never handed over as the item), and Devesh's own typed words from Claude Code's transcript
// of the session, then, when another session or a script started it, the message that started it, which is the
// request when he typed none for the work, and its later prompts, marked as script output. That transcript is a file
// the building agent could append to: docs/done-gate.md lists it among the gate's open holes. A branch's checkpoint
// (checkpoint.ts) reads Devesh's words and the roadmap item the same way.

import { readFileSync } from "node:fs";
import { parseRoadmap, plain } from "../../docs/tracker/parse.js";
import { git } from "./git";

type Prompt = { origin?: { kind?: string }; at?: string; content?: unknown };

// Claude Code caps a hook's added context at 10,000 characters.
const BUDGET = 9_000;

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n")
      : "";

/** Newest first, as text; the same words twice only once, at the newest. */
function newestFirst(prompts: Prompt[]) {
  const seen = new Set<string>();
  return [...prompts].reverse().flatMap((p) => {
    const text = textOf(p.content);
    if (seen.has(text)) return [];
    seen.add(text);
    return [{ at: p.at, text }];
  });
}

/**
 * PURE: a session transcript → the messages Devesh typed (`origin.kind` "human"; one typed while the agent was busy
 * may be recorded only as a queued_command attachment), and, when the session's first prompt has no origin (another
 * session's brief or a script's prompt, sent through the SDK), that first prompt and the later prompts with none. Tool
 * results, system reminders, task notifications and other agents' messages are not prompts anyone typed.
 */
export function promptsOf(transcript: string) {
  const prompts = transcript.split("\n").flatMap((line): Prompt[] => {
    if (!line.includes('"user"') && !line.includes('"queued_command"'))
      return [];
    try {
      const r = JSON.parse(line);
      const queued = r.attachment;
      if (r.type === "attachment" && queued?.type === "queued_command")
        return queued.origin?.kind === "human"
          ? [{ origin: queued.origin, at: r.timestamp, content: queued.prompt }]
          : [];
      return r.type === "user" && !r.isMeta && (r.origin || r.promptSource)
        ? [{ origin: r.origin, at: r.timestamp, content: r.message?.content }]
        : [];
    } catch {
      return [];
    }
  });
  const [first, ...later] = prompts;
  const started =
    first && !first.origin
      ? { at: first.at, text: textOf(first.content) }
      : undefined;
  return {
    typed: newestFirst(prompts.filter((p) => p.origin?.kind === "human")),
    started,
    byScript: started ? newestFirst(later.filter((p) => !p.origin)) : [],
  };
}

/** A checkout's roadmap item, as `items` (ROADMAP.md on origin/main) words it, found by its branch's description. */
export function itemOf(root: string, items: string[]) {
  const branch = git(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {},
    true,
  );
  const said =
    branch && git(root, ["config", `branch.${branch}.description`], {}, true);
  const item = said && items.find((i) => plain(i) === plain(said));
  return {
    item,
    line: !branch
      ? `Checkout ${root} is on no branch, so it records no roadmap item.`
      : !said
        ? `Checkout ${root} (branch ${branch}) records no roadmap item: its description is empty.`
        : item
          ? `Checkout ${root} (branch ${branch}) builds this roadmap item, word for word:\n${item}`
          : `Checkout ${root} (branch ${branch}): its description, which the building agent writes, matches no item in ROADMAP.md on origin/main, so it is no roadmap item's text. It reads: ${said}`,
  };
}

const blocks = (prompts: { at?: string; text: string }[], heading: string) =>
  prompts
    .map((p) => `--- ${heading}${p.at ? ` at ${p.at}` : ""} ---\n${p.text}`)
    .join("\n");

/** The note the verifier starts with: the request, each checkout's roadmap item, then the session's messages. */
export function requestFor(
  repo: string,
  transcript: string | undefined,
  roots: string[],
) {
  let text = "";
  try {
    text = transcript ? readFileSync(transcript, "utf8") : "";
  } catch {
    // no transcript to read: nothing typed is known
  }
  const { typed, started, byScript } = promptsOf(text);
  const roadmap = git(repo, ["show", "origin/main:ROADMAP.md"], {}, true);
  const known = parseRoadmap(roadmap).slices.flatMap((s) =>
    s.items.map((i) => i.text),
  );
  const items = roots.map((root) => itemOf(root, known));
  const where = transcript ?? "none named";
  const item =
    "the roadmap item, below, of the checkout whose change you are verifying, word for word";
  const brief = started
    ? `the message that started this session, below, word for word (another session or a script wrote it, not Devesh); when it doesn't ask for this work, ${item}`
    : item;
  const note = [
    `The done gate hands the verifier this note. Each roadmap item below is the line ROADMAP.md holds on origin/main, and Devesh's words are read from Claude Code's transcript of this session (${where}), not from the building agent's brief.`,
    typed.length
      ? `The request is what Devesh typed, below: the message or messages asking for this work. When none of them asks for it, the request is ${brief}.`
      : started || items.some((i) => i.item)
        ? `Devesh typed nothing in this session, so the request is ${brief}.`
        : "Devesh typed nothing in this session, and no checkout's branch names a roadmap item, so the gate has no request to hand you.",
    ...(roadmap
      ? []
      : [
          "ROADMAP.md on origin/main can't be read here, so no checkout's roadmap item is known.",
        ]),
    ...items.map((i) => i.line),
    ...(typed.length
      ? [
          `Devesh's typed messages in this session, newest first, each word for word:\n${blocks(typed, "typed by Devesh")}`,
        ]
      : []),
    ...(started
      ? [
          blocks(
            [started],
            "the message that started this session (another session or a script wrote it, not Devesh)",
          ),
        ]
      : []),
    ...(byScript.length
      ? [
          `Its later prompts that nobody typed, newest first, are script output, not typed by Devesh:\n${blocks(byScript, "script output, not typed by Devesh")}`,
        ]
      : []),
  ].join("\n\n");
  const cut = `\n\n(The note is cut here, at ${BUDGET} characters: ROADMAP.md on origin/main holds each item whole, and the session's transcript (${where}) holds every message whole.)`;
  return note.length > BUDGET
    ? `${note.slice(0, BUDGET - cut.length)}${cut}`
    : note;
}
