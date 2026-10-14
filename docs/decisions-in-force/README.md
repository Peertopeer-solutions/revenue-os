# Decisions in force

One file per decision still in force, so two pull requests that each make a decision never edit the same lines.
A decision is added by the pull request that makes it, as a new file here:

- named `YYYY-MM-DD-<what>.md` (the date it was made, then a few words in lower case joined by hyphens);
- holding one line: `- YYYY-MM-DD · **<the decision>** (<who decided, or the PR's link>): <what it means>`.

The reason goes in the PR that made the decision. A decision that stops holding is deleted, or its file rewritten,
by the PR that changes it. `bun run records` prints every decision, newest first by file name, for the tracker page;
`bun run cycle --check` reports a file not written this way. Until 2026-10-14 these lines lived in
STATE.md → Decisions in force; files from before that date with no date of their own carry 2026-09-25.
