#!/usr/bin/env bash
# The guards `bun run guards` runs, in CI and in the done gate. Each guard is a file in scripts/guards/, one job
# per file, run here in turn from the repository root; one that fails, or is missing, fails the run, so a guard
# can't drop out in silence. Run locally: bun run guards
set -u
here="$(cd "$(dirname "$0")" && pwd)/guards"
fail=0
for guard in service-role.sh public-address.sh console-bundle.sh pattern-files.ts anthropic-sdk.sh raw-html.sh company-filter.ts; do
  case "$guard" in
    *.ts) bun "$here/$guard" ;;
    *) bash "$here/$guard" ;;
  esac || fail=1
done
exit "$fail"
