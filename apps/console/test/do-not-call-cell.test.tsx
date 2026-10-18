// A lead's do-not-call cell on the Contacts screen (features/contacts/DoNotCallCell.tsx) in each state the page gives
// it: asking to confirm, with a way back; saving, when Block can't be pressed again; and a failed save, which says
// why. The page's own states (open, blocked) and its save are contacts-do-not-call.test.tsx.
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DoNotCallCell,
  saveFailure,
} from "../src/features/contacts/DoNotCallCell";
import { apiErrorFor, buttons, visible } from "./test-utils";

describe("DoNotCallCell", () => {
  const cell = (props: Partial<Parameters<typeof DoNotCallCell>[0]>) =>
    renderToStaticMarkup(
      <DoNotCallCell
        blocked={false}
        confirming={true}
        saving={false}
        failed={null}
        onMark={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
        {...props}
      />,
    );

  it("asks to confirm before it blocks, with a way back", () => {
    const html = cell({});
    expect(visible(html)).toContain("Block every call and message?");
    expect(buttons(html)).toEqual(["Block", "Cancel"]);
    expect(html).not.toContain('role="alert"');
  });

  it("while the save runs, its Block button can't be pressed again", () => {
    expect(cell({ saving: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Block<\/button>/,
    );
  });

  it("says why a save failed: a person who may not block, or any other failure", async () => {
    expect(saveFailure(await apiErrorFor(403))).toBe(
      "Only an operator or admin can block a lead.",
    );
    expect(saveFailure(await apiErrorFor(500))).toBe("Not saved. Try again.");
    expect(saveFailure(new Error("offline"))).toBe("Not saved. Try again.");
    const html = cell({ failed: "Not saved. Try again." });
    expect(html).toMatch(
      /<span role="alert"[^>]*>Not saved. Try again.<\/span>/,
    );
  });
});
