# Rule changes

One file per changed rule, added by the pull request that changes it (a rule file is any path `RULE_FILES` in
scripts/done-gate/rules.ts matches), so two pull requests that each change a rule never edit the same lines:

- named `YYYY-MM-DD-<what>.md` (the date, then a few words in lower case joined by hyphens, such as `2026-10-14-pr-175-rule-changes`);
- holding one line: `- YYYY-MM-DD · [#N](link) · which rule · tighter | looser | neutral | mixed`, where "which rule"
  names each changed file by its path, its file name or the folder it sits in; one line may name several files that
  changed the same way.

The records only grow: `rules-from-main` (scripts/done-gate/rule-changes.ts) refuses a PR whose changed rule files are
not all named, in its body and in a record here for its number, and one that removes or rewrites an earlier record
(moving one word for word into another file here is allowed). The records written before 2026-10-14 moved here from
STATE.md → Rule changes, word for word, on 2026-10-15; that section now only points here, and `rules-from-main` refuses
a record line written there. `bun run records` prints them all, newest first, for the tracker page.
