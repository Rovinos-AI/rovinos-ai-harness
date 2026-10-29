#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="semgrep/semgrep:1.182.0@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af"
positive_control_report="reports/semgrep-positive-control.json"
fixture_directory="$(mktemp -d)"
readonly root image positive_control_report fixture_directory
trap 'rm -rf "$fixture_directory"; rm -f "$root/$positive_control_report"' EXIT

cd "$root"
mkdir -p reports

docker run --rm --volume "$root:/src" --workdir /src "$image" \
  semgrep --test --config security/semgrep security/semgrep/tests --metrics off

docker run --rm --volume "$root:/src" --workdir /src "$image" \
  semgrep scan --config security/semgrep --error --metrics off --json \
  --output reports/semgrep.json --exclude security/semgrep/tests .

printf '%s\n' '// SPDX-License-Identifier: Apache-2.0' 'eval("unsafe");' \
  > "$fixture_directory/positive-control.ts"
if docker run --rm --volume "$root:/src" --volume "$fixture_directory:/positive-control:ro" \
  --workdir /src "$image" semgrep scan --config security/semgrep --error --metrics off --json \
  --output "$positive_control_report" /positive-control
then
  printf '%s\n' "Semgrep positive control was not detected." >&2
  exit 1
fi

if ! grep -Fq "harness.no-eval" "$positive_control_report"; then
  printf '%s\n' "Semgrep positive control failed without the expected finding." >&2
  exit 1
fi
