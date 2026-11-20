#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_directory="$(cd -- "$script_directory/../.." && pwd)"
cd "$root_directory"

yarn build

export HARNESS_CONFIG="$script_directory/harness.config.yaml"
export HARNESS_DATA_DIR="$root_directory/.tmp/approval-demo-$$"
HARNESS_KEY="$(
  node packages/cli/dist/bin.js --json keys generate |
    node --input-type=module -e '
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      process.stdout.write(JSON.parse(input).key);
    '
)"
export HARNESS_KEY
APPROVAL_DEMO_CONTROL_TOKEN="$(
  node --input-type=module -e '
    import { randomBytes } from "node:crypto";
    process.stdout.write(randomBytes(32).toString("hex"));
  '
)"
export APPROVAL_DEMO_CONTROL_TOKEN
mkdir -p "$HARNESS_DATA_DIR"
chmod 700 "$HARNESS_DATA_DIR"

approval_demo_port="${APPROVAL_DEMO_PORT:-3190}"
control_plane_log="$HARNESS_DATA_DIR/control-plane.log"
node packages/cli/dist/bin.js serve --http --port "$approval_demo_port" >"$control_plane_log" 2>&1 &
control_plane_pid=$!

cleanup() {
  if kill -0 "$control_plane_pid" 2>/dev/null; then
    kill "$control_plane_pid" 2>/dev/null || true
    wait "$control_plane_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for _ in {1..80}; do
  if grep -q '^http://' "$control_plane_log"; then
    break
  fi
  if ! kill -0 "$control_plane_pid" 2>/dev/null; then
    printf 'approval_demo_control_plane_failed\n' >&2
    exit 1
  fi
  sleep 0.25
done

control_plane_url="$(grep -Eo 'http://127\.0\.0\.1:[0-9]+[^[:space:]]*' "$control_plane_log" | head -n 1 || true)"
if [ -z "$control_plane_url" ]; then
  printf 'approval_demo_control_plane_timeout\n' >&2
  exit 1
fi

set +e
run_output="$(node packages/cli/dist/bin.js --json run --input examples/quickstart/task.json --fake-model examples/quickstart/fake-model.script.json 2>/dev/null)"
run_status=$?
set -e
if [ "$run_status" -ne 5 ]; then
  printf 'approval_demo_run_failed\n' >&2
  exit 1
fi
run_id="$(printf '%s' "$run_output" | node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.parse(input).runId);
')"
approval_list="$(node packages/cli/dist/bin.js --json approvals list)"
approval_id="$(printf '%s' "$approval_list" | APPROVAL_DEMO_RUN_ID="$run_id" node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const result = JSON.parse(input);
  const approval = result.approvals.find((entry) => entry.runId === process.env.APPROVAL_DEMO_RUN_ID);
  if (approval === undefined) process.exitCode = 1;
  else process.stdout.write(approval.approvalId);
')"

printf 'Control plane: %s\n' "$control_plane_url"
printf 'Suspended run: %s\n' "$run_id"
printf 'Pending approval: %s\n' "$approval_id"
printf 'Local data directory: %s\n' "$HARNESS_DATA_DIR"
node packages/cli/dist/bin.js approvals show "$approval_id" --view
