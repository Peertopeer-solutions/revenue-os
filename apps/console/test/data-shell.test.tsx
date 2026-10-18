// The DataShell primitive (ui/primitives/DataShell.tsx): the loading / error / empty / content branch the console's
// data pages share. Props: isLoading, isError, isEmpty?, loadingText? (default "Loading…"), errorText? (default
// "Unable to load data."), emptyText?, children. Each non-happy state renders as <p className="text-sm text-muted">,
// marked with its state (data-state), which the browser check that opens every screen reads; children render ONLY
// on the happy path.
//
// Env-free by construction (bun test + renderToStaticMarkup, no DOM library, no DB/network,
// no new deps) — imitates apps/console/test/ui-smoke.test.tsx. Each case first checks the barrel exports DataShell.
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import * as primitives from "../src/ui/primitives";
import { asPrimitivesMap, visible } from "./test-utils";

// unique marker for the happy-path children — must be ABSENT in every non-happy state.
const ROWS = "data-shell-children-marker";
const children = <div>{ROWS}</div>;

// Undefined until the worker adds the primitive; each test guards typeof === "function".
const P = asPrimitivesMap(primitives);

describe("DataShell — loading / error / empty / content branches", () => {
  it("loading: default 'Loading…' in a muted <p>, children hidden", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell isLoading isError={false}>
        {children}
      </DataShell>,
    );
    expect(html.startsWith("<p")).toBe(true); // state = a bare <p>, nothing else
    expect(html).toContain("text-sm");
    expect(html).toContain("text-muted");
    expect(visible(html)).toContain("Loading…"); // default loadingText
    expect(html).not.toContain(ROWS); // children hidden while loading
  });

  it("error: default 'Unable to load data.' in a muted <p>, children hidden", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell isLoading={false} isError>
        {children}
      </DataShell>,
    );
    expect(html.startsWith("<p")).toBe(true);
    expect(html).toContain("text-sm");
    expect(html).toContain("text-muted");
    expect(visible(html)).toContain("Unable to load data."); // default errorText
    expect(html).not.toContain(ROWS); // children hidden on error
  });

  it("empty: renders emptyText in a muted <p>, children hidden", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell
        isLoading={false}
        isError={false}
        isEmpty
        emptyText="No tasks."
      >
        {children}
      </DataShell>,
    );
    expect(html.startsWith("<p")).toBe(true);
    expect(html).toContain("text-sm");
    expect(html).toContain("text-muted");
    expect(visible(html)).toContain("No tasks.");
    expect(html).not.toContain(ROWS); // children hidden on empty
  });

  it("empty: emptyText omitted renders the default 'Nothing here yet.' (never a blank <p>)", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell isLoading={false} isError={false} isEmpty>
        {children}
      </DataShell>,
    );
    expect(html.startsWith("<p")).toBe(true);
    expect(html).toContain("text-sm");
    expect(html).toContain("text-muted");
    expect(visible(html)).toBe("Nothing here yet."); // default emptyText, no blank <p>
    expect(html).not.toContain(ROWS); // children hidden on empty
  });

  it("happy path (all flags false, isEmpty omitted): renders children, no state copy", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell isLoading={false} isError={false}>
        {children}
      </DataShell>,
    );
    expect(html).toContain(ROWS); // children shown
    const text = visible(html);
    expect(text).not.toContain("Loading…");
    expect(text).not.toContain("Unable to load data.");
  });

  it("custom loadingText is respected (default not rendered)", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell isLoading isError={false} loadingText="Fetching orgs…">
        {children}
      </DataShell>,
    );
    expect(visible(html)).toContain("Fetching orgs…");
    expect(visible(html)).not.toContain("Loading…");
  });

  it("custom errorText is respected (default not rendered)", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell isLoading={false} isError errorText="Transcript unavailable.">
        {children}
      </DataShell>,
    );
    expect(visible(html)).toContain("Transcript unavailable.");
    expect(visible(html)).not.toContain("Unable to load data.");
  });

  it("defaults are exact: 'Loading…' and 'Unable to load data.'", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const loading = renderToStaticMarkup(
      <DataShell isLoading isError={false} />,
    );
    const error = renderToStaticMarkup(<DataShell isLoading={false} isError />);
    expect(visible(loading)).toBe("Loading…");
    expect(visible(error)).toBe("Unable to load data.");
  });

  it("each non-happy state is marked with the state it is in, and the happy path with none", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const marks = [
      <DataShell key="l" isLoading isError={false} />,
      <DataShell key="e" isLoading={false} isError />,
      <DataShell key="m" isLoading={false} isError={false} isEmpty />,
      <DataShell key="c" isLoading={false} isError={false}>
        {children}
      </DataShell>,
    ].map(
      (shell) => renderToStaticMarkup(shell).match(/data-state="(\w+)"/)?.[1],
    );
    expect(marks).toEqual(["loading", "error", "empty", undefined]);
  });

  it("precedence: loading wins over error", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell
        isLoading
        isError
        loadingText="LOADING_WINS"
        errorText="ERROR_LOSES"
      />,
    );
    expect(visible(html)).toContain("LOADING_WINS");
    expect(visible(html)).not.toContain("ERROR_LOSES");
  });

  it("precedence: error wins over empty", () => {
    const DataShell = P.DataShell;
    expect(typeof DataShell).toBe("function");
    const html = renderToStaticMarkup(
      <DataShell
        isLoading={false}
        isError
        isEmpty
        errorText="ERROR_WINS"
        emptyText="EMPTY_LOSES"
      />,
    );
    expect(visible(html)).toContain("ERROR_WINS");
    expect(visible(html)).not.toContain("EMPTY_LOSES");
  });
});
