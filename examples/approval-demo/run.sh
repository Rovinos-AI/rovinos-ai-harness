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
approval_list="$(node packages/cli/dist/bin.js --json approvals list 2>/dev/null)"
approval_id="$(printf '%s' "$approval_list" | APPROVAL_DEMO_RUN_ID="$run_id" node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const result = JSON.parse(input);
  const approval = result.approvals.find((entry) => entry.runId === process.env.APPROVAL_DEMO_RUN_ID);
  if (approval === undefined) process.exitCode = 1;
  else process.stdout.write(approval.approvalId);
')"

printf 'Control plane: embedded in the local CLI runtime (no network endpoint)\n'
printf 'Suspended run: %s\n' "$run_id"
printf 'Pending approval: %s\n' "$approval_id"
printf 'Local data directory: %s\n' "$HARNESS_DATA_DIR"
printf 'Reference host URL:\n'
node packages/cli/dist/bin.js approvals show "$approval_id" --view
