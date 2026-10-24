# Crash and resume

From the repository root, install and build, start the example run, kill its process after the
non-idempotent tool has committed a durable receipt, then resume from the SQLite event log:

<!-- test:run -->

```bash
set -euo pipefail
yarn install --immutable
yarn build
mkdir -p .tmp
data_dir=".tmp/crash-and-resume-$$"
mkdir "$data_dir"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$data_dir"
}
trap cleanup EXIT
node --experimental-strip-types --disable-warning=ExperimentalWarning examples/crash-and-resume/run.ts start "$data_dir" >"$data_dir/process.log" 2>&1 &
pid=$!
for attempt in {1..100}; do
  if [[ -s "$data_dir/run-id" && -f "$data_dir/effect-ready" ]]; then
    break
  fi
  sleep 0.1
done
test -s "$data_dir/run-id"
test -f "$data_dir/effect-ready"
kill -KILL "$pid"
if wait "$pid"; then
  printf 'expected the run process to be killed\n' >&2
  exit 1
else
  status=$?
  test "$status" -eq 137
fi
run_id="$(cat "$data_dir/run-id")"
node --experimental-strip-types --disable-warning=ExperimentalWarning examples/crash-and-resume/run.ts resume "$data_dir" "$run_id"
```

Expected output:

```text
run status: completed
non-idempotent tool executions: 1
```

The tool commits its synthetic side effect and recovery receipt atomically before the process is
killed. On resume, its recovery strategy returns the recorded result instead of executing the
non-idempotent operation again. No model provider key or external service is used.
