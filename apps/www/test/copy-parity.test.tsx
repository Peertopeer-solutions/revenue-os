// Copy + first-paint spec for the landing page, asserted on the SSR render of
// <App/> — exactly what a visitor sees before any script runs or any animation
// plays. Pins: the buyer-outcome copy, one "Book a demo" action, the hero's
// listen button and its honesty note, the hero as study A3 (a plain mono eyebrow;
// one finished call's result card, one labelled image with no clock time on its
// face, on the drawing sheet with the floor plan drawn; the old looping call card
// gone), the page told in order — hero, How it works (its intro with the
// "Illustrative example" tag and the headline's accent words, then five unnumbered
// steps as vertical tabs beside a product window that frames the call brief and the
// intent study), "The call and after" (the engine panel, opening on the call at
// 7:14 PM, with no numbers of its own), examples, pilot, the pilot report, FAQ,
// closing — both studies' final frame (the brief on the page; the intent study, held
// back in the window until its step, rendered on its own), the running total the
// score builds through, Priya's reply docked in the finished brief, the sound
// switch, one call-now rule and one follow-up plan,
// Rohan's one evening (lead lands 7:12, Priya's answer 7:13, the call 7:14, WhatsApp
// 7:16, the visit) told the same in every section, the honest labelling of the
// pilot report and the plans, a score out of 100 only inside How it works, the
// retired copy staying retired, and the default UI state and accessible shape
// (pause switch, FAQ, phone menu). Machine tests pin copy + state, never pixels —
// visual parity needs a human eye.
//
// App + react-dom/server load via try/catch so a broken tree fails as assertions,
// never as an opaque import crash. App is imported directly (not main.tsx), so it
// must stay SSR-safe — main.tsx owns the stylesheet import.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ComponentType, createElement } from "react";
import {
  howItWorks,
  howSteps,
  intentScore,
  intentSignals,
} from "../src/content/beforeCall";
import { callBrief } from "../src/content/callBrief";
import { examples } from "../src/content/examples";
import { result, sampleCall } from "../src/content/hero";
import { intentEvidence } from "../src/content/intentEvidence";
import { brand } from "../src/content/site";
import { workflow } from "../src/content/workflow";
import { CHECK } from "../src/visuals/Icon";

let markup = "";
let studyMarkup = "";
let appLoaded = false;

beforeAll(async () => {
  try {
    const server = await import("react-dom/server");
    const mod = (await import("../src/App")) as { App?: ComponentType };
    if (typeof mod.App === "function") {
      markup = server.renderToStaticMarkup(createElement(mod.App));
      appLoaded = true;
    }
    // The intent study on its own: on the page it waits, hidden, for its step.
    const { IntentEvidence } = await import("../src/visuals/IntentEvidence");
    studyMarkup = server.renderToStaticMarkup(createElement(IntentEvidence));
  } catch (err) {
    console.error(err);
  }
});

const decode = (s: string) =>
  s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
// Text content only (tags stripped, entities decoded) — copy pins shouldn't care
// which element carries the words.
const textOf = (html: string) =>
  decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
// How it works' headline sets its accent words in clay spans; read as plain words.
const unaccent = (h: string) =>
  h.replace(/<span class="text-clay-type">([^<]*)<\/span>/g, "$1");
const text = () => textOf(unaccent(markup));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whitespace (a no-break space) reads as one space.
const oneSpace = (s: string) => s.replace(/\s+/g, " ");

// The element that opens at `from` (the index of its "<tag"), through its
// matching close tag, nested elements of the same name included.
function element(html: string, from: number): string {
  const name =
    from < 0 ? undefined : /^<([a-z][\w-]*)/i.exec(html.slice(from))?.[1];
  if (!name) return "";
  const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  tag.lastIndex = from;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(from, tag.lastIndex);
  }
  return "";
}
// The innermost <section> around the first `needle` in `html` ("" when absent).
function sectionAround(html: string, needle: string): string {
  const at = html.indexOf(needle);
  let i = at < 0 ? -1 : html.lastIndexOf("<section", at);
  while (i >= 0) {
    const s = element(html, i);
    if (i + s.length > at) return s;
    i = i > 0 ? html.lastIndexOf("<section", i - 1) : -1;
  }
  return "";
}
// The element of `tag` that opens nearest before the first `needle` in `html`.
const around = (html: string, tag: string, needle: string) => {
  const at = html.indexOf(needle);
  return at < 0 ? "" : element(html, html.lastIndexOf(`<${tag}`, at));
};

// The hero band: the drawing sheet, then the hero section (copy, plan, card).
const heroBand = () =>
  element(markup, markup.indexOf("<div", markup.indexOf("<main")));
// The hero's drawing sheet: the band's markup before the hero section opens.
const surveyGround = () => {
  const main = markup.indexOf("<main");
  return markup.slice(main, markup.indexOf("<section", main));
};
// The page's one <figure>: the floor plan with the result card lying on it.
const figure = () => /<figure\b[\s\S]*?<\/figure>/.exec(markup)?.[0] ?? "";
const surveyPlan = () => around(figure(), "div", "data-plot=");
const card = () => around(figure(), "div", 'role="img"');
// How it works (id "how"): the intro, then the steps beside the window.
const how = () => sectionAround(markup, ' id="how"');
// The window (the steps' tab panel), and the call brief showing in it (it opens on
// its screen-reader summary)…
const panel = () => around(how(), "div", 'role="tabpanel"');
const brief = () => around(how(), "div", '<p class="sr-only">');
// …the intent study's pane in the window (hidden until its step), and the study
// rendered on its own, at its final frame (one labelled image).
const onPage = () => around(how(), "div", 'data-pane="study"');
const study = () => studyMarkup;
// The five steps: each a tab.
const tabs = () =>
  [...how().matchAll(/<button\b[^>]*role="tab"[\s\S]*?<\/button>/g)].map(
    (m) => m[0],
  );
// The intro: How it works up to its step list.
const intro = () =>
  how().slice(0, how().lastIndexOf("<div", how().indexOf('role="tablist"')));
// An attribute of an element's opening tag.
const attr = (html: string, name: string) =>
  new RegExp(`^<[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1];
// The call and after: the dark engine panel.
const engine = () => sectionAround(markup, ' id="the-call"');
const examplesSection = () => sectionAround(markup, ' id="examples"');
// The pilot section (its plans included), and the pilot report after it.
const pilotSection = () => sectionAround(markup, ' id="pilot"');
const report = () => sectionAround(markup, 'aria-labelledby="proof-title"');
// A clock reading on the page: "7:14 PM", "7:13:40 PM", "11:00 AM".
const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2})?\s[AP]M\b/g;
const clocks = (s: string) => [...s.matchAll(CLOCK)].map((m) => m[0]);
// Every <li> whose own content carries `needle`.
const itemsWith = (html: string, needle: string) =>
  [...html.matchAll(/<li\b(?:(?!<\/li>).)*<\/li>/gs)]
    .map((m) => m[0])
    .filter((li) => textOf(li).includes(needle));

// ── first-frame visibility ──────────────────────────────────────────────────
// The open tags around each text run in `html` that carries `needle` (the whole
// run when `exact`): its element and every ancestor. Attributes never match.
const VOID = /^(?:area|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
function runs(html: string, needle: string, exact = false): string[][] {
  const words = esc(
    needle
      .replace(/&/g, "&amp;")
      .replace(/'/g, "&#x27;")
      .replace(/"/g, "&quot;"),
  )
    .trim()
    .split(/\s+/)
    .join("\\s+");
  const at = new RegExp(exact ? `>\\s*${words}\\s*<` : `>[^<]*?${words}`, "g");
  return [...html.matchAll(at)].map((m) => {
    const open: Array<[string, string]> = [];
    for (const [tag, close, name = ""] of html
      .slice(0, (m.index ?? 0) + 1) // through the ">" that opens the run
      .matchAll(/<(\/?)([a-z][\w-]*)[^>]*>/gi)) {
      if (close) {
        const i = open.map(([n]) => n).lastIndexOf(name);
        if (i >= 0) open.length = i;
      } else if (!VOID.test(name) && !tag.endsWith("/>"))
        open.push([name, tag]);
    }
    return open.map(([, tag]) => tag);
  });
}
// A tag that keeps its content out of view until a later beat: faded out, not
// yet drawn (a zero scale or a clip), or visually hidden.
const HELD =
  /(?:^|\s)(?:opacity-0|invisible|sr-only|\[clip-path:inset\(0_100%_0_0\)\])(?:\s|$)/;
const holds = (tag: string) =>
  HELD.test(/\sclass="([^"]*)"/.exec(tag)?.[1] ?? "") ||
  /\sstyle="[^"]*(?:opacity:\s*0(?![.\d])|scale[XY]?\(0\))/.test(tag);
// On first paint at least one run of `needle` is in view…
function inView(html: string, needle: string, exact = false) {
  const found = runs(html, needle, exact);
  expect(found.length, `"${needle}" renders`).toBeGreaterThan(0);
  expect(
    found.some((tags) => !tags.some(holds)),
    `"${needle}" is in view on first paint`,
  ).toBe(true);
}
// …or every run of it is held back (a beat that belongs before the final frame).
function heldBack(html: string, needle: string, exact = false) {
  const found = runs(html, needle, exact);
  expect(found.length, `"${needle}" renders`).toBeGreaterThan(0);
  expect(
    found.every((tags) => tags.some(holds)),
    `"${needle}" is held back in the final frame`,
  ).toBe(true);
}

test("App renders to static markup", () => {
  expect(appLoaded).toBe(true);
});

describe("copy — the buyer-outcome story", () => {
  const COPY: Array<[string, string]> = [
    ["nav link", "How it works"],
    ["hero eyebrow", "Voice AI for Indian real estate"],
    ["hero headline", "Turn property enquiries into qualified site visits."],
    [
      "hero sub",
      "Revenue OS calls new leads in Hinglish, qualifies budget and timeline, and follows up on WhatsApp",
    ],
    ["hero secondary", "Hear a sample call"],
    ["proof badge", "Illustrative example"],
    ["proof title", "What your pilot report shows"],
    ["proof metric", "Enquiries called the same day"],
    [
      "how it works",
      "Follow one lead, from the moment it lands to the site visit.",
    ],
    ["how it works, step 3", "Your team answers once. Every call knows."],
    ["how it works, step 4", "Every score shows its working."],
    ["the call and after", "The call, then the next step"],
    ["step 1", "Respond quickly"],
    ["step 1 body", "Call a new enquiry."],
    ["step 2", "Understand the buyer"],
    ["step 2 body", "Capture budget, location, and timeline."],
    ["step 3", "Arrange the next step"],
    ["step 3 body", "Book a visit or continue following up."],
    ["follow-up branch", "Not ready to visit yet?"],
    ["examples heading", "What the buyer hears, and what your team gets"],
    ["example 1", "A natural Hinglish conversation"],
    ["example 2", "A summary your salesperson can use"],
    ["example 3", "Site-visit confirmation and reminder"],
    ["pilot", "Start with a four-week pilot"],
    ["pilot — who", "Who it suits"],
    ["pilot — measured", "How success is measured"],
    ["pilot — fees", "How fees work"],
    ["plans are secondary", "Compare plans"],
    ["faq — voice", "How natural does the voice sound?"],
    ["faq — team", "Does it replace my sales team?"],
    ["faq — integrations", "Which tools does it work with?"],
    ["faq — onboarding", "How long does onboarding take?"],
    ["faq — pricing", "How does pricing work?"],
    ["faq — do-not-call", "How are do-not-call rules handled?"],
    ["closing", "See how Revenue OS would handle your next property enquiry."],
    [
      "closing sub",
      "Hear a sample call, review the qualification summary, and see how a site visit gets booked.",
    ],
  ];
  for (const [label, needle] of COPY) {
    test(`renders: ${label}`, () => expect(text()).toContain(needle));
  }

  // Checked against the visible text AND the attributes (aria-labels speak too).
  const RETIRED = [
    "Run our pilot",
    "Subscribe and connect",
    "Book a pilot",
    "12,000+",
    "eleven Indian languages",
    "₹60K",
    "₹0",
    "The revenue operating system for Indian real",
    // honesty: no live portal intake, no seconds-to-call claim, no absolute promise, no
    // invented plan limit or metric that implies live intake (CSV import only, today)
    "99acres",
    "MagicBricks",
    "47 sec",
    "Called in",
    "no enquiry goes quiet",
    "Up to 500 leads",
    "Median time to first call",
    // no CRM write-back shown as built (planned); an intent score (also planned)
    // is scoped to the illustrative "Before the call" section, below
    "Written to CRM",
    // the previous design's old copy stays gone now its layout is back
    "See the engine",
    "MERIDIAN",
    "VASTU ONE",
    "GRIHA CO.",
    "NORTHGATE",
    "ANVAYA",
    "Four stages run on machine time",
    "HIGH INTENT",
    "Three competitors, three moats",
    "Choose a plan to connect Revenue OS",
    "Choose plan",
    "Subscribe",
    "Asked before every pilot",
    "Give us one project",
    // the old looping call card (HeroCall) and its lit floor plan stay gone: the
    // hero is study A3, one finished result on an unlabelled plan
    // (the sample call's transcript greets Rohan too, so the card's own words are
    // pinned: "…Meridian Homes se")
    "New lead",
    "Agent · Asha",
    "Meridian Homes se",
    "Budget around 90 lakh",
    "Ringing…",
    "Readiness",
    "Ready to visit",
    "Not ready yet",
    "Rahul",
    "Kharadi",
    "Summary for your team",
    "Ended 00:42",
    "Visit · Sat",
    // the flow told once, in order: the intent study is the brief's Intent row
    // opened up (not a ranking of leads), the call and after opens on the call (the
    // clock doesn't go back to the lead landing), the examples are that call up close
    // (not a restart of the story), the steps tell the brief in the order it plays
    // (no buyer asked anything), and the call-now line reads "50 or more" everywhere
    "Who to call first",
    "Enquiry imported",
    "from your enquiry list",
    "Every enquiry that gets a call goes through the same three steps",
    "Built around how property sales actually work",
    "One enquiry, followed from the call to the site visit",
    "When a buyer asks something the brochure doesn't cover",
    "over 50 means call now",
    // How it works is steps beside a window now: no chapter numbers, and the
    // chapters' own subs are gone
    "01 · Before the call",
    "02 · Call now or follow up",
    "03 · The call and after",
    "The Intent row from Rohan's brief, opened up",
  ];
  for (const needle of RETIRED) {
    test(`no longer renders: ${needle}`, () => {
      expect(text()).not.toContain(needle);
      expect(decode(markup)).not.toContain(needle);
    });
  }

  test("no seconds-to-call claim anywhere", () => {
    expect(text()).not.toMatch(/\b\d+\s*(?:sec|secs|seconds)\b/i);
  });

  test("languages: Hinglish, Hindi and English only", () => {
    expect(text()).not.toMatch(
      /\b(?:Tamil|Telugu|Kannada|Marathi|Bengali|Bangla|Gujarati|Malayalam|Punjabi|Odia)\b/,
    );
  });
});

describe("one primary action — Book a demo", () => {
  test("appears on at least four primary buttons (nav, hero, pilot, closing)", () => {
    const buttons =
      markup.match(
        /<button\b[^>]*>(?:(?!<\/button>).)*Book a demo(?:(?!<\/button>).)*<\/button>/gs,
      ) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
  });

  test("is never a plain link to another section", () => {
    expect(markup).not.toMatch(
      /<a\b[^>]*>(?:(?!<\/a>).)*Book a demo(?:(?!<\/a>).)*<\/a>/s,
    );
  });

  test("the booking dialog is on the page, labelled, and closed on first paint", () => {
    const dialog = /<dialog\b[^>]*>/.exec(markup)?.[0] ?? "";
    expect(dialog, "a <dialog> must render").not.toBe("");
    expect(dialog).toMatch(/aria-labelledby="[^"]+"/);
    expect(dialog).not.toMatch(/\sopen(?:=|\s|>)/);
  });
});

describe("the hero's listen button — the sample recording, played in place", () => {
  test('a button reads "Hear a sample call" with the recording\'s 1:13 length', () => {
    expect(markup).toMatch(
      /<button\b(?:(?!<\/button>).)*Hear a sample call(?:(?!<\/button>).)*1:13(?:(?!<\/button>).)*<\/button>/s,
    );
    // its other states' labels hold the pill's width, invisible until they apply
    const label = /<span class="([^"]*)">Hear a sample call<\/span>/.exec(
      markup,
    );
    expect(label?.[1], "the idle label renders").toBeDefined();
    expect(label?.[1]).not.toContain("invisible");
  });

  test("says what the recording is, visibly, right beside it", () => {
    const note =
      /<p\b([^>]*)>(?:(?!<\/p>).)*A dramatised call: both voices are generated with ElevenLabs, and Rohan is not a real customer\. Names and figures are illustrative\./s.exec(
        markup,
      );
    expect(note, "the disclosure renders").not.toBeNull();
    expect(note?.[1]).not.toMatch(/sr-only|\bhidden\b|invisible|aria-hidden/);
    // …and screen readers hear it with the button it qualifies
    const id =
      /<p\b[^>]*\bid="([^"]+)"[^>]*>(?:(?!<\/p>).)*A dramatised call: both voices/s.exec(
        markup,
      )?.[1];
    expect(id, "the disclosure has an id").toBeDefined();
    expect(markup).toContain(`aria-describedby="${id}"`);
  });

  test("nothing is fetched on first paint; a load failure has a live region", () => {
    expect(markup).not.toContain("<audio");
    expect(markup).not.toContain("sample-call.m4a");
    expect(markup).toContain('role="status"');
    expect(text()).not.toContain(sampleCall.unavailable);
  });

  test("plays /sample-call.m4a, whose real length is the 1:13 shown", () => {
    expect(sampleCall.src).toBe("/sample-call.m4a");
    expect(sampleCall.seconds).toBe(73);
    const file = resolve(import.meta.dir, "../public/sample-call.m4a");
    expect(existsSync(file), "public/sample-call.m4a must exist").toBe(true);
    // The MP4 movie header (mvhd) holds the timescale and duration.
    const buf = readFileSync(file);
    const i = buf.indexOf("mvhd");
    expect(i).toBeGreaterThan(0);
    const v1 = buf[i + 4] === 1;
    const scale = buf.readUInt32BE(i + (v1 ? 24 : 16));
    const units = v1
      ? Number(buf.readBigUInt64BE(i + 28))
      : buf.readUInt32BE(i + 20);
    expect(Math.abs(units / scale - sampleCall.seconds)).toBeLessThan(1);
  });

  test("its index comes before its audio, so playback starts before the file has fully arrived", () => {
    const buf = readFileSync(
      resolve(import.meta.dir, "../public/sample-call.m4a"),
    );
    expect(buf.indexOf("moov")).toBeGreaterThan(0);
    expect(buf.indexOf("moov")).toBeLessThan(buf.indexOf("mdat"));
  });

  // The recording's text alternative (WCAG 1.2.1): every line, closed until asked.
  test('a closed "Read the transcript" holds every line of the call, speaker first', () => {
    const block = around(heroBand(), "details", "Read the transcript");
    expect(block, "the transcript renders in the hero").not.toBe("");
    expect(block).not.toMatch(/^<details\b[^>]*\bopen\b/);
    expect(block).toMatch(/<summary\b[^>]*>Read the transcript<\/summary>/);
    const said = textOf(block);
    for (const { who, text } of sampleCall.transcript)
      expect(said).toContain(oneSpace(`${who} ${text}`));
  });

  test("the agent says it is an AI in its first line", () => {
    const [first] = sampleCall.transcript;
    expect(first.who).toMatch(/\bAI\b/);
    expect(first.text).toMatch(/\bAI assistant\b/);
  });

  test("it is Rohan's call from the Examples: each line shown there is said in it, by the same side", () => {
    const agent = sampleCall.transcript[0].who;
    for (const line of examples.conversation.lines) {
      const said = sampleCall.transcript.find((l) =>
        l.text.includes(line.text),
      );
      expect(said, line.text).toBeDefined();
      expect(said?.who === agent).toBe(line.who === "Agent");
    }
  });

  test("the pin the call promises on WhatsApp right away comes with the confirmation", () => {
    const promise = sampleCall.transcript.find((l) =>
      /location pin/i.test(l.text),
    );
    expect(promise?.text).toContain("abhi WhatsApp");
    expect(examples.visit.messages[0].text).toContain(
      "Here is the location pin",
    );
  });

  test("the summary your salesperson gets lists only what Rohan asked on the call", () => {
    const asked = examples.summary.fields.find(
      (f) => f.label === "Asked about",
    );
    const rohan = sampleCall.transcript
      .filter((l) => l.who === "Rohan")
      .map((l) => l.text.toLowerCase())
      .join(" ");
    expect(asked).toBeDefined();
    for (const topic of asked?.value.split(", ") ?? [])
      expect(rohan, topic).toContain(topic.toLowerCase());
  });
});

describe("the hero — study A3: one finished call, on the drawing sheet", () => {
  test("the eyebrow is plain mono type, as in the study (no kicker dot)", () => {
    const band = heroBand();
    const eyebrow = runs(band, "Voice AI for Indian real estate", true);
    expect(eyebrow.length).toBe(1);
    expect(eyebrow[0]?.at(-1)).toMatch(/^<span\b[^>]*\bfont-mono\b/);
    const head = band.slice(band.indexOf("<section"), band.indexOf("<h1"));
    expect(head, "no clay dot before the headline").not.toContain("bg-clay");
  });

  test("the result card is one labelled image: an illustrative result of one call", () => {
    expect(figure().match(/\srole="img"/g)?.length, "one image").toBe(1);
    const tag = /^<div\b[^>]*>/.exec(card())?.[0] ?? "";
    expect(tag).toContain('role="img"');
    const label = oneSpace(decode(/aria-label="([^"]*)"/.exec(tag)?.[1] ?? ""));
    expect(label).toStartWith("Illustrative result of one call:");
    for (const s of [
      "Rohan Mehta",
      "landed at 7:12 PM",
      "in Hinglish 2 min later",
      "a budget of ₹90 lakh",
      "a 2 BHK in Whitefield",
      "within 12 months",
      "booked a site visit for Saturday at 11:00 AM",
    ])
      expect(label).toContain(s);
  });

  test("first paint is the study's card, finished: Rohan, called 2 min after it landed, captured, visit booked", () => {
    expect(textOf(card()).trim()).toBe(
      "Rohan Mehta Called 2 min after it landed Captured ₹90 L 2 BHK · Whitefield Within 12 months Site visit booked · Sat 11:00 AM",
    );
    for (const s of [
      "Rohan Mehta",
      "Called 2 min after it landed",
      "Captured",
      "₹90 L",
      "2 BHK · Whitefield",
      "Within 12 months",
      "Site visit booked · Sat 11:00 AM",
    ])
      inView(card(), s, true);
  });

  test("names no lead portal and shows no score as a number", () => {
    const all = `${textOf(figure())} ${decode(figure())}`;
    expect(all).not.toMatch(
      /99\s?acres|magic\s?bricks|housing\.com|nobroker|proptiger|commonfloor|square\s?yards/i,
    );
    expect(all).not.toMatch(/\b\d{1,3}\s*\/\s*100\b|\bout\s+of\s+100\b/);
  });

  test("the pause switch (WCAG 2.2.2) is one real button in the copy column, under the listen button's note", () => {
    const buttons =
      markup.match(
        /<button\b(?:(?!<\/button>).)*Pause animations(?:(?!<\/button>).)*<\/button>/gs,
      ) ?? [];
    expect(buttons.length).toBe(1);
    const [button = ""] = buttons;
    const tag = /^<button\b[^>]*>/.exec(button)?.[0] ?? "";
    expect(tag).toContain('type="button"');
    expect(tag, "a 44px touch target").toContain("min-h-[44px]");
    expect(tag, "nothing to pause under reduced motion").toContain(
      "motion-reduce:hidden",
    );
    expect(tag).not.toContain("aria-hidden");
    const band = heroBand();
    expect(band).toContain(button);
    expect(band.indexOf(button)).toBeGreaterThan(
      band.indexOf("A dramatised call: both voices"),
    );
    // the plan and the card stand alone, as in the study
    expect(figure()).not.toContain("<button");
  });
});

describe("the hero's drawing sheet and floor plan — decorative, drawn on first paint", () => {
  test("the sheet's title strip names the flat and says it is illustrative", () => {
    const ground = surveyGround();
    expect(ground).toMatch(/^<main[^>]*><div\b[^>]*><div aria-hidden="true"/);
    inView(ground, "Meridian Greens · Tower B · Typical 2 BHK");
    inView(ground, "Illustrative", true);
  });

  test("the plan lies in the figure under the card, aria-hidden, already drawn", () => {
    const plan = surveyPlan();
    const tag = /^<div\b[^>]*>/.exec(plan)?.[0] ?? "";
    expect(tag, "the plan renders inside the figure").toContain(
      'data-plot="done"',
    );
    expect(tag).toContain('aria-hidden="true"');
    expect(tag).not.toMatch(/\srole=/);
    expect(plan, "its drawing is in the server render").toContain(
      'viewBox="0 0 320 400"',
    );
    expect(figure().indexOf(plan), "under the card").toBeLessThan(
      figure().indexOf(card()),
    );
  });

  test("it is the study's plan: unlabelled linework, dimensioned across its width", () => {
    expect(textOf(surveyPlan()).trim()).toBe("9.75 m");
    inView(surveyPlan(), "9.75 m", true);
  });
});

describe("the page, told in order — one lead, from the moment it lands to the site visit", () => {
  // Each mark, in the order a visitor scrolls to it; each is on the page once.
  const ORDER: Array<[string, string]> = [
    ["the hero", "<h1"],
    ["How it works", ' id="how"'],
    [
      "its intro",
      ">Follow one lead, from the moment it lands to the site visit.<",
    ],
    ["its steps", 'role="tablist"'],
    ...howSteps.map((s, i): [string, string] => [
      `step ${i + 1}'s title`,
      `>${s.title.replace(/\. .*/, ".")}`, // its first sentence (a later one keeps to a line of its own)
    ]),
    ["the window", 'role="tabpanel"'],
    ["the call brief in it", ">A call brief for Rohan Mehta writes itself"],
    [
      "the intent study in it",
      'aria-label="Illustrative: why Rohan Mehta is a high-intent buyer.',
    ],
    ["the engine panel", ' id="the-call"'],
    ["its kicker", ">The call and after<"],
    ["its heading", ">The call, then the next step<"],
    ["its opening, the call", ">At 7:14 PM the agent calls Rohan."],
    ["its first step, the call started", ">Call started · 7:14 PM<"],
    ["the examples", ' id="examples"'],
    ["their heading", ">What the buyer hears, and what your team gets<"],
    ["the pilot", ' id="pilot"'],
    ["its heading", ">Start with a four-week pilot<"],
    ["the pilot report", 'aria-labelledby="proof-title"'],
    ["its kicker", ">Pilot report<"],
    ["its heading", ">What your pilot report shows<"],
    ["the FAQ", ' id="faq"'],
    ["the closing", ' id="cta"'],
  ];

  test("hero → How it works (intro, five steps, the window: the brief, the intent study) → the call and after → examples → pilot → pilot report → FAQ → closing", () => {
    const page = unaccent(markup);
    const at = ORDER.map(([label, mark]) => {
      expect(page.split(mark).length - 1, `${label} is on the page once`).toBe(
        1,
      );
      return page.indexOf(mark);
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  test("How it works opens on its intro, tagged illustrative, which labels the section", () => {
    const id = /^<section\b[^>]*aria-labelledby="([^"]+)"/.exec(how())?.[1];
    expect(id, "the section is labelled by its heading").toBeDefined();
    // the accent words in clay spans (same serif, colour only: never em or i);
    // punctuation outside them, in ink
    expect(how()).toMatch(
      new RegExp(
        `<h2\\b[^>]*id="${id}"[^>]*>${esc('Follow one lead, from the moment it <span class="text-clay-type">lands</span> to the <span class="text-clay-type">site visit</span>.')}</h2>`,
      ),
    );
    const h2 = /<h2\b[\s\S]*?<\/h2>/.exec(how())?.[0] ?? "";
    expect(h2).not.toMatch(/<(?:em|i)\b/);
    for (const word of howItWorks.accents)
      expect(h2).toContain(`<span class="text-clay-type">${word}</span>`);
    // the kicker, its tag, the heading and the lede, then the steps
    expect(textOf(unaccent(intro())).trim()).toBe(
      "How it works Illustrative example Follow one lead, from the moment it lands to the site visit. One evening, one buyer: Rohan Mehta's enquiry lands at 7:12 PM. Here is what Revenue OS does before it calls him, how it decides to call now or follow up, and what happens on the call and after.",
    );
    inView(intro(), "Illustrative example", true);
    for (const tags of runs(intro(), "Illustrative example"))
      for (const tag of tags) expect(tag).not.toContain("aria-hidden");
  });

  test("the steps are vertical tabs: five, in story order, the last selected on first paint", () => {
    const list = /<div\b[^>]*role="tablist"[^>]*>/.exec(how())?.[0] ?? "";
    expect(list).toContain('aria-orientation="vertical"');
    expect(decode(attr(list, "aria-label") ?? "")).toBe(
      "Rohan's enquiry, step by step",
    );
    const all = tabs();
    expect(all.length).toBe(5);
    const win = panel();
    const panelId = attr(win, "id");
    expect(panelId, "the window is the tab panel").toBeDefined();
    const selected = all.filter((t) => attr(t, "aria-selected") === "true");
    expect(selected.length, "one tab selected").toBe(1);
    all.forEach((tab, i) => {
      const step = howSteps[i];
      const on = i === all.length - 1; // the finished story: the last step
      // its name is its title alone
      const title = attr(tab, "aria-labelledby") ?? "";
      expect(textOf(around(tab, "span", ` id="${title}"`)).trim()).toBe(
        step?.title ?? "",
      );
      expect(attr(tab, "aria-selected")).toBe(String(on));
      expect(attr(tab, "tabindex"), "one tab stop: the selected tab").toBe(
        on ? "0" : "-1",
      );
      expect(attr(tab, "aria-controls")).toBe(panelId);
      if (on) {
        expect(attr(win, "aria-labelledby")).toBe(attr(tab, "id"));
        inView(tab, step?.body ?? "");
        const desc = attr(tab, "aria-describedby") ?? "";
        expect(textOf(around(tab, "span", ` id="${desc}"`)).trim()).toBe(
          oneSpace(step?.body ?? ""),
        );
      } else {
        heldBack(tab, step?.body ?? "");
        expect(attr(tab, "aria-describedby")).toBeUndefined();
      }
    });
    // step titles are not headings (none is allowed inside a tab)
    expect(how()).not.toContain("<h3");
  });

  test("the window: tagged illustrative, the brief showing, the intent study held back until its step", () => {
    const win = panel();
    inView(win, "Illustrative example", true);
    for (const tags of runs(win, "Illustrative example"))
      for (const tag of tags) expect(tag).not.toContain("aria-hidden");
    expect(win).toContain(brief());
    expect(win).toContain(onPage());
    heldBack(onPage(), "Calling Rohan · 7:14 PM", true);
    // before the brief, only the top bar: the tab's name (decoration, hidden from
    // screen readers: the window is named by its step), then the pill
    const bar = win.slice(0, win.indexOf(brief()));
    expect(textOf(bar).trim()).toBe(`${brand} ${howItWorks.illustrative}`);
    for (const tags of runs(bar, brand, true))
      expect(tags.some((t) => t.includes('aria-hidden="true"'))).toBe(true);
  });

  test("The call and after: its heading, the call at 7:14 PM, then directly its flow", () => {
    const id = /^<section\b[^>]*aria-labelledby="([^"]+)"/.exec(engine())?.[1];
    expect(id, "the panel is labelled by its heading").toBeDefined();
    expect(engine()).toMatch(
      new RegExp(
        `<h3\\b[^>]*id="${id}"[^>]*>The call, then the next step</h3>`,
      ),
    );
    expect(workflow.intro).toStartWith("At 7:14 PM the agent calls Rohan.");
    expect(textOf(engine()).trim()).toStartWith(
      `${workflow.kicker} ${workflow.title} ${workflow.intro} ${workflow.flow.entry}`,
    );
  });

  test("no chapter numbers, and no step numbers inside the steps or the engine panel", () => {
    // the engine panel: no chapter number, and its steps and the flow's nodes carry
    // no 01 / 02 / 03 of their own
    const panelText = textOf(engine()).trim();
    expect(panelText).not.toMatch(/^\d/);
    expect(panelText.replace(CLOCK, ""), "no 01–03 in the panel").not.toMatch(
      /\b0\d\b/,
    );
    for (const s of workflow.steps) {
      const [li = ""] = itemsWith(engine(), s.title);
      expect(textOf(li).trim(), `${s.tag}: no number before it`).toStartWith(
        `${s.tag} ${s.title} ${s.body}`,
      );
    }
    // How it works' steps: each tab opens on its title, no number before it
    tabs().forEach((tab, i) => {
      expect(textOf(tab).trim()).toStartWith(howSteps[i]?.title ?? "?");
    });
    // the intent study: the step strip names the six steps, unnumbered, at
    // Intent · 7:13:40 PM
    const { steps, at, time } = intentEvidence.story;
    const strip = around(study(), "ol", `>${steps[0]}<`);
    expect(textOf(strip).trim()).toBe(
      oneSpace(
        steps.map((s, i) => (i === at ? `${s} · ${time}` : s)).join(" "),
      ),
    );
  });

  test("the nav's “How it works” goes to #how, the section that tells it", () => {
    const links = [
      ...markup.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>How it works<\/a>/g),
    ];
    expect(links.length, "the bar's link and the phone menu's").toBe(2);
    for (const [, href] of links) expect(href).toBe("#how");
  });
});

// The four signals and their weights, as both studies show them.
const SIGNALS: Array<[string, string]> = [
  ["Repeat enquiry", "+24"],
  ["Budget fits", "+22"],
  ["Timeline known", "+16"],
  ["Asked about possession before", "+16"],
];

describe("the call brief — its final frame in How it works' window on first paint", () => {
  test("tells a screen reader the story once, Priya's reply included", () => {
    const summary = textOf(
      /<p class="sr-only">(?:(?!<\/p>).)*<\/p>/s.exec(brief())?.[0] ?? "",
    );
    for (const s of [
      "A call brief for Rohan Mehta writes itself before the call",
      "the agent asks Priya Nair, the sales manager, on WhatsApp",
      'She replies: "Yes — one covered spot. Floor rise is extra above the 10th floor."',
      "saved to the Meridian Greens facts",
      "Repeat enquiry +24, Budget fits +22, Timeline known +16, Asked about possession before +16: intent 78 out of 100, high.",
      "the agent calls Rohan at 7:14 PM in Hinglish",
    ])
      expect(summary).toContain(s);
  });

  test("the facts, the saved answer, the score, the plan, Ready", () => {
    for (const s of [
      "Rohan Mehta",
      "2 BHK in Whitefield, budget up to ₹90 L",
      "Meridian Greens · Tower B",
      "Second enquiry this month",
      "Hinglish · evenings",
      // the open question, answered by Priya and saved to the project
      "One covered car park included",
      "Floor rise is extra above the 10th floor",
      "from Priya · 7:13 PM",
      "Saved to Meridian Greens facts",
      // the intent row and the rail's sum
      "78 / 100",
      "= 78 / 100",
      "4 signals · 50 or more means call now",
      // the call plan
      "Call plan",
      "6 steps · Hinglish",
      "Greet in Hinglish",
      "Confirm 2 BHK, Whitefield, ₹90 L",
      "Possession: December 2027",
      "Covered car park included",
      "from Priya",
      "Offer a Saturday site visit",
      "Offer the home‑loan partner",
      // ready, and calling
      "Ready",
      "Ready · calling 7:14 PM",
      "Calling in Hinglish · 0:0",
      "Brief ready. Calling Rohan at 7:14 PM, in Hinglish.",
    ])
      inView(brief(), s, true);
    for (const [signal, weight] of SIGNALS) {
      inView(brief(), signal, true);
      inView(brief(), weight, true);
    }
    expect(textOf(brief())).toContain("What the agent looked at");
    // both meters stand at the score: 78 of 100
    expect(brief().match(/transform:scaleX\(0\.78\)/g)?.length).toBe(2);
    // the beats before the final frame are held back
    for (const s of [
      "Preparing",
      "Asking Priya Nair on WhatsApp…",
      "not in brochure",
      "The call waits for the brief",
    ])
      heldBack(brief(), s, true);
    heldBack(brief(), "Rohan Mehta, a new lead, just landed.");
  });

  test("the home loan the intent study weighs is in his own enquiry, the words he sent", () => {
    const [enquiry] = callBrief.rows;
    expect(enquiry?.source).toBe("from his enquiry");
    expect(enquiry?.note).toContain("loan bhi lena hai");
    inView(brief(), "loan bhi lena hai");
  });

  test("the score builds from the signals: a running total 24, 46, 62, 78, then = 78 / 100", () => {
    const running = intentSignals.map((_, i) =>
      intentSignals.slice(0, i + 1).reduce((sum, s) => sum + s.weight, 0),
    );
    expect(running).toEqual([24, 46, 62, 78]);
    expect(running.at(-1)).toBe(intentScore.total);
    const score = `${intentScore.total} / ${intentScore.outOf}`;
    // Each calculation stacks its figures in one cell: every running total, then
    // the sum ("= 78 / 100" under the rail's signals from 720px, "78 / 100" in the
    // Intent row that adds them up itself on phones). The final frame shows the
    // sum alone; the totals before it have risen away, so none overlaps it.
    for (const sum of [`= ${score}`, score]) {
      const stack = new RegExp(
        [...running, sum]
          .map((v) => `(<span\\b[^>]*>)${esc(`${v}`)}</span>`)
          .join(""),
      ).exec(brief());
      expect(stack, `the running totals, then "${sum}"`).not.toBeNull();
      expect(stack?.slice(1).map(holds)).toEqual([
        ...running.map(() => true),
        false,
      ]);
      inView(brief(), sum, true);
    }
  });

  test("Priya's reply stays docked in the finished brief; her pop-up has gone", () => {
    const found = runs(brief(), callBrief.priya.reply, true);
    // her pop-up is the floating card (.brief-float) that covers the brief while
    // she replies; the docked copies sit under her rail source (from 720px) and
    // under the caption bar (phones), where her name goes with it
    const popup = (tags: string[]) =>
      tags.some((t) => t.includes("brief-float"));
    const docked = found.filter((tags) => !popup(tags));
    const popups = found.filter(popup);
    expect(docked.length, "docked from 720px and on phones").toBe(2);
    for (const tags of docked)
      expect(tags.some(holds), "docked, in view").toBe(false);
    expect(popups.length, "the pop-up renders, to pop in").toBeGreaterThan(0);
    for (const tags of popups)
      expect(tags.some(holds), "pop-up gone").toBe(true);
    inView(brief(), callBrief.priya.name, true);
  });

  test("Priya's WhatsApp reply is on the page, quoting the question it answers", () => {
    const t = textOf(brief());
    for (const s of [
      "Priya Nair",
      "Sales manager · WhatsApp",
      "Is one covered car park included in the ₹88 L price?",
      "Yes — one covered spot. Floor rise is extra above the 10th floor.",
    ])
      expect(t).toContain(s);
  });

  test("the sound switch is a real button with aria-pressed, off until audio can play", () => {
    const buttons =
      how().match(
        /<button\b[^>]*aria-pressed="(?:true|false)"[^>]*>(?:(?!<\/button>).)*Sound(?:(?!<\/button>).)*<\/button>/gs,
      ) ?? [];
    expect(buttons.length).toBe(1);
    const tag = /<button\b[^>]*>/.exec(buttons[0] ?? "")?.[0] ?? "";
    expect(tag).toContain('type="button"');
    expect(tag).toContain('aria-pressed="false"');
    expect(tag).toContain("min-h-[44px]");
    for (const tags of runs(how(), "Sound", true))
      for (const t of tags) expect(t).not.toContain('aria-hidden="true"');
  });
});

describe("the intent study — its final frame, rendered on its own", () => {
  test("it opens up the brief's Intent row: the same score, the same line", () => {
    const { total, outOf, callNow } = intentScore;
    const row = callBrief.intent;
    const step = howSteps[3]?.body ?? "";
    expect(step).toContain(`${total} out of ${outOf}`);
    expect(step).toContain(`At ${callNow} or more`);
    // the row it opens is on show in the finished brief
    inView(brief(), row.label, true);
    inView(brief(), row.score, true);
    inView(brief(), row.note, true);
  });

  test("the call-now line reads the same everywhere: at or over 50 calls, under 50 follows up", () => {
    const { callNow } = intentScore;
    expect(callBrief.intent.note).toEndWith(
      `${callNow} or more means call now`,
    );
    expect(intentEvidence.routing.note).toStartWith(
      `${callNow} and over gets a call tonight. Under ${callNow} gets the follow-up plan.`,
    );
    expect(intentEvidence.callNow.kicker).toEndWith(`at ${callNow} and over`);
    expect(intentEvidence.followUp.kicker).toEndWith(`under ${callNow}`);
    // never "over 50" alone, which would leave a buyer at exactly 50 unrouted
    const page = `${text()} ${decode(markup)}`;
    expect(page).not.toMatch(
      new RegExp(`\\b(?:over|above|more than)\\s+${callNow}\\b`),
    );
  });

  test("one labelled image that tells the story once", () => {
    const label = decode(
      /^<div\b[^>]*\brole="img" aria-label="([^"]*)"/.exec(study())?.[1] ?? "",
    );
    expect(label).toStartWith(
      "Illustrative: why Rohan Mehta is a high-intent buyer.",
    );
    for (const s of [
      "repeat enquiry, plus 24",
      "budget fits, plus 22",
      "timeline known, plus 16",
      "asked about possession before, plus 16",
      "Needing a home loan is context for the call, not a minus.",
      "The total is 78 out of 100, above the call-now line at 50",
      "the follow-up plan instead",
    ])
      expect(label).toContain(s);
  });

  test("four signals with weights, 78 / 100, call now", () => {
    for (const [signal, weight] of SIGNALS) {
      inView(study(), signal, true);
      inView(study(), weight, true);
    }
    for (const s of [
      "Needs a home loan",
      "context, not a minus",
      "Call now",
      "Tonight, in Hinglish, with the brief in hand",
      "Calling Rohan · 7:14 PM",
      "Follow-up plan",
      "High",
      "78",
      "/ 100",
    ])
      inView(study(), s, true);
    const t = textOf(study());
    expect(t).toContain("50 · call-now line");
    expect(t).toContain(
      "50 and over gets a call tonight. Under 50 gets the follow-up plan. Weights and the line are examples.",
    );
    // the caption on show is the route, not the opening line
    inView(study(), "Calling him now, in Hinglish, at 7:14 PM.");
    heldBack(study(), "Before I call, I'll weigh what I found about Rohan.");
    expect(study(), "every bar is drawn").not.toMatch(/scale[XY]\(0\)/);
  });
});

// ── one follow-up plan: the intent study's card and the engine panel's plan agree
// The engine panel's "Example follow-up plan" is the source (Today · Day 7 · Day 30);
// the intent study's "Follow-up plan" card tells the same steps in one line, in the same
// order, and a screen reader hears the same plan — no second cadence anywhere.
describe("one follow-up plan — the intent study's card and the engine panel's plan agree", () => {
  const { plan } = workflow.followUp;
  const card = intentEvidence.followUp.body;
  // one space, plain hyphens (a non-breaking one reads the same), lower case
  const norm = (s: string) =>
    oneSpace(s)
      .replace(/\u2011/g, "-")
      .toLowerCase();
  // what each step does, in words both places use
  const KINDS = ["floor plans", "check-in", "re-call"];
  const kind = (s: string) => KINDS.find((k) => norm(s).includes(k));
  const when = (s: string) => new RegExp(`\\b${esc(norm(s))}\\b`);

  test("the same steps on the same days, in the same order", () => {
    const clauses = norm(card).split(/,\s*/);
    expect(clauses.length).toBe(plan.length);
    plan.forEach((step, i) => {
      const clause = clauses[i] ?? "";
      expect(clause, `step ${i + 1}: ${step.when}`).toMatch(when(step.when));
      expect(kind(step.what), `"${step.what}" is a known step`).toBeDefined();
      expect(kind(clause), `step ${i + 1}: the same action`).toBe(
        kind(step.what),
      );
    });
  });

  test("both are on show: the intent study's card under its name, the plan in the engine panel", () => {
    expect(intentEvidence.followUp.title).toBe("Follow-up plan");
    expect(textOf(study())).toContain(
      `${intentEvidence.followUp.title} ${oneSpace(card)}`,
    );
    const panel = textOf(engine());
    expect(panel).toContain(workflow.followUp.label);
    for (const step of plan)
      expect(panel).toContain(oneSpace(`${step.when} ${step.what}`));
  });

  test("a screen reader hears the same plan, and the page names no other cadence", () => {
    // the intent study's one text alternative tells the follow-up route too
    const spoken = norm(intentEvidence.summary);
    const route = spoken.slice(spoken.indexOf("the follow-up plan"));
    for (const step of plan)
      expect(route, `the summary's plan names ${step.when}`).toMatch(
        when(step.when),
      );
    // every "day N" / "N days" anywhere — text or attributes — is a plan day
    const days = new Set(plan.flatMap((s) => /\d+/.exec(s.when) ?? []));
    const named = [
      ...norm(decode(markup)).matchAll(/\bday\s+(\d+)\b|\b(\d+)\s+days?\b/g),
    ].map((m) => m[1] ?? m[2] ?? "");
    expect(named.filter((d) => !days.has(d))).toEqual([]);
  });
});

// ── Rohan's evening: one timeline, told the same in every section ──────────
// The anchor is the call, where the engine panel opens: its first step's example
// ("Call started · 7:14 PM", "Called 2 min after it landed"), so the lead
// landed at 7:12 PM. The hero's card shows no clock time, as in study A3 (only its label
// says 7:12 PM). Every other time is read from the content modules and checked
// against the anchor, so a section can't drift to its own story.
// A clock reading ("7:12 PM", "7:13:40 PM", "Thu 7:16 PM") in seconds after midnight…
const clock = (s: string) => {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP])M/.exec(s);
  expect(m, `"${s}" holds a time`).not.toBeNull();
  const [, h = "0", min = "0", sec = "0", half] = m ?? [];
  return (
    ((Number(h) % 12) + (half === "P" ? 12 : 0)) * 3600 +
    Number(min) * 60 +
    Number(sec)
  );
};
// …and back, to the minute: "7:14 PM".
const toClock = (t: number) => {
  const h = Math.floor(t / 3600) % 24;
  const min = String(Math.floor(t / 60) % 60).padStart(2, "0");
  return `${h % 12 || 12}:${min} ${h < 12 ? "AM" : "PM"}`;
};

describe("Rohan's timeline — one evening, the same in every section", () => {
  const [first] = workflow.steps;
  const called = first.example.time;
  const after = Number(/(\d+)\s*min\b/.exec(first.example.delay)?.[1]);
  const landed = toClock(clock(called) - after * 60);
  const calledAfter = `${first.example.delay} ${first.example.after}`;
  const [confirmation] = examples.visit.messages;
  const between = (s: string) => {
    expect(clock(s), `${s} is after the lead landed`).toBeGreaterThanOrEqual(
      clock(landed),
    );
    expect(clock(s), `${s} is before the call`).toBeLessThan(clock(called));
  };

  test("one evening: the lead lands 7:12 PM, Priya answers 7:13 PM, called 7:14 PM, WhatsApp 7:16 PM", () => {
    expect([
      landed,
      toClock(clock(callBrief.priya.time)),
      called,
      toClock(clock(confirmation.time)),
    ]).toEqual(["7:12 PM", "7:13 PM", "7:14 PM", "7:16 PM"]);
    expect(calledAfter).toBe("2 min after it landed");
  });

  test("the anchor — the call and after opens on the call at 7:14 PM, and its clock never goes back to the lead landing", () => {
    const panel = textOf(engine());
    expect(panel).toContain(`${first.example.label} · ${called}`);
    expect(panel).toContain(`${first.example.status} ${calledAfter}`);
    expect(workflow.intro).toStartWith(`At ${called} `);
    const times = clocks(panel);
    expect(times[0], "the first time on the panel is the call").toBe(called);
    expect(
      times,
      "the time the lead landed is the brief's, not the panel's",
    ).not.toContain(landed);
    for (const t of times.filter((t) => t.endsWith("PM")))
      expect(clock(t), `${t} is not before the call`).toBeGreaterThanOrEqual(
        clock(called),
      );
  });

  test("the hero's card is the same call and shows no clock time; its label says landed at 7:12 PM", () => {
    expect(result.lead).toBe("Rohan Mehta");
    expect<string>(result.called).toBe(`Called ${calledAfter}`);
    const label = oneSpace(result.aria);
    expect(label).toContain(`landed at ${landed}`);
    expect(label).toContain(`${first.example.delay} later`);
    // on its face, the only clock is the visit's slot
    const slot = /Sat,?\s+(\d{1,2}:\d{2}\s[AP]M)/.exec(result.outcome)?.[1];
    expect(clocks(textOf(card()))).toEqual([oneSpace(slot ?? "")]);
  });

  test("the call brief: landed 7:12 PM, Priya answers at 7:13 PM, called 7:14 PM", () => {
    const shown = textOf(brief());
    // the moment the lead landed, as the brief's card and its first source state it
    const at = /landed\s+(.+)$/.exec(callBrief.card.sub)?.[1] ?? "";
    expect(oneSpace(at)).toBe(landed);
    expect(oneSpace(callBrief.rail.items[0]?.detail ?? "")).toEndWith(landed);
    expect(shown).toContain(oneSpace(callBrief.card.sub));
    // Priya's answer, in between
    expect(shown).toContain(oneSpace(callBrief.question.source));
    // the call, everywhere the brief names it
    for (const s of [
      callBrief.footer.stamp,
      callBrief.captions.at(-1)?.text ?? "",
      callBrief.summary,
    ])
      expect(oneSpace(s)).toContain(called);
    expect(shown).toContain(oneSpace(callBrief.footer.stamp));
    // every beat of the brief lands in order, between the two
    const beats = callBrief.captions.map((c) => clock(c.time));
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    for (const s of [
      ...callBrief.captions.map((c) => c.time),
      callBrief.priya.time,
      callBrief.question.source,
      callBrief.intent.source,
    ])
      between(s);
  });

  test("the intent study: scored before the call, and calls at 7:14 PM", () => {
    between(intentEvidence.story.time);
    for (const s of [
      intentEvidence.callNow.chip,
      intentEvidence.captions.route,
      intentEvidence.summary,
    ])
      expect(oneSpace(s)).toContain(called);
    expect(textOf(study())).toContain(oneSpace(intentEvidence.callNow.chip));
    expect(textOf(onPage())).toContain(oneSpace(intentEvidence.callNow.chip));
  });

  test("the examples are that call, up close: Rohan's, confirmed on WhatsApp at Thu 7:16 PM", () => {
    expect(examples.intro).toStartWith("Rohan's call, up close:");
    expect(examples.summary.lead).toBe(result.lead);
    expect(examples.visit.contact).toBe(result.lead);
    expect(oneSpace(confirmation.time)).toBe("Thu 7:16 PM");
    expect(
      clock(confirmation.time),
      "sent once the call (the sample call's length) has ended",
    ).toBeGreaterThan(clock(called) + sampleCall.seconds);
    expect(textOf(examplesSection())).toContain(oneSpace(confirmation.time));
  });

  test("the visit it books is one slot everywhere: Saturday, 11:00 AM", () => {
    const slot = /Sat,?\s+(\d{1,2}:\d{2}\s[AP]M)/.exec(result.outcome)?.[1];
    expect(oneSpace(slot ?? "")).toBe("11:00 AM");
    const visits = [
      ...text().matchAll(
        /\bSat(?:urday)?\b,?\s+(?:at\s+)?(\d{1,2}:\d{2}\s[AP]M)/g,
      ),
    ].map((m) => m[1]);
    // the hero's card, the engine panel, the summary, the confirmation
    expect(visits.length).toBeGreaterThanOrEqual(4);
    expect(new Set(visits)).toEqual(new Set([oneSpace(slot ?? "")]));
  });
});

describe("a score out of 100 — only inside How it works, labelled illustrative", () => {
  const SCORE = /\/\s*100\b|\b\d{1,3}\s+(?:out\s+)?of\s+100\b/;

  test("appears in How it works' steps and window, tagged “Illustrative example” in its kicker row and on the window", () => {
    expect(textOf(how())).toMatch(SCORE);
    const head = how().slice(0, how().indexOf("<h2"));
    inView(head, "Illustrative example", true);
    inView(panel(), "Illustrative example", true);
    // the intro itself states no score
    expect(textOf(unaccent(intro()))).not.toMatch(SCORE);
  });

  test("appears nowhere else: not the hero, the engine panel, the examples, the pilot or the pilot report", () => {
    const outside = markup.replace(how(), "");
    expect(outside.length).toBe(markup.length - how().length);
    expect(textOf(outside)).not.toMatch(SCORE);
    expect(decode(outside)).not.toMatch(SCORE);
  });
});

describe("the pilot report — after the Pilot it reports on; an example, never a customer result", () => {
  test("sits directly after the Pilot section, under its “Pilot report” kicker and an “Illustrative example” tag", () => {
    const pilot = pilotSection();
    const r = report();
    expect(pilot.length, "the pilot section renders").toBeGreaterThan(0);
    expect(r.length, "the pilot report renders").toBeGreaterThan(0);
    expect(markup.indexOf(r), "nothing between them").toBe(
      markup.indexOf(pilot) + pilot.length,
    );
    const head = r.slice(0, r.indexOf("</h2>"));
    expect(textOf(head).trim()).toBe(
      "Pilot report Illustrative example What your pilot report shows",
    );
    inView(head, "Pilot report", true);
    inView(head, "Illustrative example", true);
    for (const tags of runs(head, "Illustrative example"))
      for (const tag of tags) expect(tag).not.toContain("aria-hidden");
  });

  test("is labelled as an illustrative example throughout", () => {
    const t = textOf(report());
    for (const s of [
      "Illustrative example",
      "Example project:",
      "Current process (example)",
      "Revenue OS (example)",
      "The figures are illustrative, not customer results.",
    ]) {
      expect(t).toContain(s);
    }
  });

  test("carries no quotation or testimonial", () => {
    expect(markup).not.toMatch(/<(?:blockquote|q|cite)\b/);
  });
});

describe("pilot — built vs planned, no rates", () => {
  // The callers, senders and do-not-call records aren't live yet: the FAQ says
  // what the pilot will do, never that it works today.
  test("the FAQ's tools and do-not-call answers speak of the pilot, not of today", () => {
    const faq = textOf(sectionAround(markup, ' id="faq"'));
    expect(faq).toContain(
      "In the pilot, your leads come in as a CSV export from the system you use today, and Revenue OS will call them",
    );
    expect(faq).toContain(
      "In the pilot, Revenue OS will check your do-not-call list",
    );
    expect(faq).not.toContain("follow-ups go out by voice and WhatsApp");
    expect(faq).not.toContain("Revenue OS checks your do-not-call list");
  });

  test('three plans, the last one "Custom", none with a price figure', () => {
    const t = textOf(pilotSection());
    for (const s of [
      "Pilot",
      "Funnel Engine",
      "Custom",
      "Agreed per engagement",
    ])
      expect(t).toContain(s);
    expect(t).not.toMatch(/₹|\$|\d+\s*(?:K|k|L|lakh)\b|\/\s*(?:mo|month)\b/);
    expect(text()).toContain("Rates are agreed per project");
  });

  test("a check marks only what exists; roadmap items sit under Planned, unchecked", () => {
    const section = pilotSection();
    expect(textOf(section)).toContain("Planned");
    const check = `d="${CHECK}"`;
    for (const built of [
      "Voice calls and WhatsApp follow-ups",
      "Qualification summaries for your team",
      "Pay per qualified site visit",
    ]) {
      const items = itemsWith(section, built);
      expect(items.length, `"${built}" renders`).toBeGreaterThan(0);
      for (const li of items) expect(li).toContain(check);
    }
    for (const planned of [
      "CRM connectors",
      "Intent scoring",
      "Loan handoff",
      "Possession servicing",
      "Documentation workflows",
    ]) {
      const items = itemsWith(section, planned);
      expect(items.length, `"${planned}" renders`).toBeGreaterThan(0);
      for (const li of items) expect(li).not.toContain(check);
    }
  });

  test("plans are a closed disclosure with nothing to select", () => {
    expect(markup).toMatch(
      /<button\b[^>]*aria-expanded="false"[^>]*>Compare plans/,
    );
    expect(markup).not.toMatch(/data-plan=|data-selected=|type="radio"/);
  });
});

describe("accessibility + first paint", () => {
  test("faq: six items, item 0 open by default, the rest closed", () => {
    const items = [...markup.matchAll(/<[a-z]+\b[^>]*data-faq="(\d+)"[^>]*>/g)];
    expect(items.length).toBe(6);
    for (const [tag, i] of items)
      expect(tag).toContain(
        i === "0" ? 'data-open="true"' : 'data-open="false"',
      );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(text()).toContain("not a recording of a real one. On the demo");
  });

  test("landmarks and exactly one h1 — the hero headline", () => {
    for (const tag of ["nav", "header", "main", "footer"]) {
      expect(new RegExp(`<${tag}[\\s>]`, "i").test(markup)).toBe(true);
    }
    const h1s = markup.match(/<h1[\s>](?:(?!<\/h1>).)*<\/h1>/gs) ?? [];
    expect(h1s.length).toBe(1);
    expect(textOf(h1s[0] ?? "")).toContain(
      "Turn property enquiries into qualified site visits.",
    );
  });

  test("the phone menu starts closed, names its toggle, and lists every section", () => {
    expect(markup).toMatch(
      /<button\b[^>]*aria-expanded="false"[^>]*aria-controls="nav-menu"[^>]*aria-label="Menu"/,
    );
    const menu = /<ul id="nav-menu"[^>]*>(?:(?!<\/ul>).)*<\/ul>/s.exec(markup);
    expect(menu?.[0], "the menu renders").toMatch(/^<ul id="nav-menu" hidden/);
    const LINKS: Array<[string, string]> = [
      ["How it works", "how"],
      ["Examples", "examples"],
      ["Pilot", "pilot"],
      ["FAQ", "faq"],
    ];
    for (const [label, id] of LINKS) {
      expect(menu?.[0]).toContain(`href="#${id}"`);
      expect(textOf(menu?.[0] ?? "")).toContain(label);
      expect(markup, `the #${id} target exists`).toContain(` id="${id}"`);
    }
  });

  test("the footer's legal links reach the privacy policy at /privacy and the terms at /terms", () => {
    const legal = around(markup, "nav", 'aria-label="Legal"');
    expect(around(markup, "footer", legal), "inside the footer").toContain(
      legal,
    );
    expect(legal).toMatch(/<a href="\/privacy"[^>]*>Privacy policy<\/a>/);
    expect(legal).toMatch(/<a href="\/terms"[^>]*>Terms of service<\/a>/);
  });

  test("nothing is hidden by an inline style on first paint", () => {
    expect(markup).not.toMatch(/style="[^"]*opacity:\s*0/);
  });
});

// ── the story talks about a lead landing, never an "import" (Devesh) ─────────
// Sales teams say lead and site visit, and leads will come by more than one channel
// (CSV today; CRM connectors and inbound calls are planned). The hero, How it works
// (its window included: captions, header, source chips) and the call and after never
// say "import" or name a channel (portal, CSV, CRM): "lands" is true for every
// channel, today's and planned. The Pilot and FAQ, which state how leads arrive
// today, may.
const STORY_BANNED = /\bimport|\bportals?\b|\bCSV\b|\bCRM\b/i;
describe("the story never says import, and names no channel", () => {
  for (const [name, part] of [
    ["the hero", () => sectionAround(markup, "<h1")],
    ["how it works, window included", how],
    ["the call and after", engine],
  ] as const)
    test(`${name} has no "import" and names no channel`, () => {
      const shown = textOf(part());
      expect(shown.length, `${name} rendered`).toBeGreaterThan(200);
      expect(shown).not.toMatch(STORY_BANNED);
    });
  test("every caption, header, source and step the story can show avoids them too", () => {
    const all = JSON.stringify([
      callBrief.captions,
      callBrief.card,
      callBrief.rows,
      callBrief.rail,
      intentEvidence.story,
      result,
      howItWorks,
      howSteps,
    ]);
    expect(all).not.toMatch(STORY_BANNED);
  });
});
