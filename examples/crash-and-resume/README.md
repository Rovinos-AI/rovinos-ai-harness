# Crash and resume

From the repository root, install and build, start the example run, kill its process after the
non-idempotent tool has committed a durable receipt, then resume from the SQLite event log:

<!-- test:run -->

```bash
set -euo pipefail
yarn install --immutable
yarn build
mkdir -p .tmp
data_dir="$(mktemp -d .tmp/crash-and-resume.XXXXXX)"
trap 'rm -rf "$data_dir"' EXIT
node --experimental-strip-types --disable-warning=ExperimentalWarning examples/crash-and-resume/run.ts demo "$data_dir"
```

Expected output:

```text
run status: completed
non-idempotent tool executions: 1
```

The tool commits its synthetic side effect and recovery receipt atomically before the process is
killed. On resume, its recovery strategy returns the recorded result instead of executing the
non-idempotent operation again. No model provider key or external service is used.
