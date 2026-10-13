// CI's secret scan (docs/security.md S9.3) runs the gitleaks program itself, first in the quick job: the gitleaks
// action needs a paid licence in an organization's repository. Read from .github/workflows/ci.yml.
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
};
const ci = Bun.YAML.parse(
  readFileSync(
    join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
    "utf8",
  ),
) as { jobs: Record<string, { steps?: Step[] }> };
const quick = ci.jobs.quick?.steps ?? [];
const scan = quick.find((s) => s.name?.startsWith("Secret scan")) ?? {};

it("scans right after the checkout, before anything is installed", () => {
  expect(quick.indexOf(scan)).toBe(1);
  expect(quick[0]?.uses).toStartWith("actions/checkout@");
});

it("checks the download against its published checksum before it runs it, all of one pinned version", () => {
  const lines = (scan.run ?? "").trim().split("\n");
  const version = scan.name?.match(/gitleaks (\d+\.\d+\.\d+)/)?.[1];
  expect(version).toBeDefined();
  expect(lines[0]).toContain(
    `/download/v${version}/gitleaks_${version}_linux_x64.tar.gz`,
  );
  expect(lines[1]).toMatch(
    /^echo "[0-9a-f]{64} {2}\$RUNNER_TEMP\/gitleaks\.tar\.gz" \| sha256sum -c -$/,
  );
  expect(lines.at(-1)).toBe(
    '"$RUNNER_TEMP/gitleaks" git --redact --verbose --log-opts="$RANGE" .',
  );
  expect(lines).toHaveLength(4);
});

// The merge queue's build (merge_group) has no commit before it, so it scans its own since the commit the queue built on.
it("scans a pull request's commits since its base, and a push's since the commit before it", () => {
  expect(scan.env?.RANGE).toBe(
    `\${{ github.event_name == 'pull_request' && format('origin/{0}..{1}', github.base_ref, github.event.pull_request.head.sha) || github.event_name == 'merge_group' && format('{0}..{1}', github.event.merge_group.base_sha, github.event.merge_group.head_sha) || format('{0}..{1}', github.event.before, github.sha) }}`,
  );
});

it("no job uses the gitleaks action, which stops without a licence here", () => {
  const uses = Object.values(ci.jobs).flatMap((j) =>
    (j.steps ?? []).map((s) => s.uses ?? ""),
  );
  expect(uses.filter((u) => u.startsWith("gitleaks/"))).toEqual([]);
});
