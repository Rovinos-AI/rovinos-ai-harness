#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

readonly gitleaks_image="zricethezav/gitleaks:v8.30.1"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly repository_root

usage() {
  printf 'Usage: %s [--nightly] [--source <repository>]\n' "${0##*/}" >&2
}

nightly=false
source_dir="$repository_root"

while (($# > 0)); do
  case "$1" in
    --nightly)
      if [[ "$nightly" == true ]]; then
        usage
        exit 2
      fi
      nightly=true
      shift
      ;;
    --source)
      if [[ $# -lt 2 || -z "$2" ]]; then
        usage
        exit 2
      fi
      source_dir=$2
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ ! -d "$source_dir" ]] || ! git -C "$source_dir" rev-parse --git-dir >/dev/null 2>&1; then
  printf 'Secret scan source must be a Git repository.\n' >&2
  exit 2
fi

source_dir="$(cd "$source_dir" && pwd)"
if [[ "$nightly" != true ]] && ! git -C "$source_dir" rev-parse --verify origin/main >/dev/null 2>&1; then
  printf 'Secret scan requires the origin/main ref; fetch full history before scanning.\n' >&2
  exit 2
fi

report_dir="$source_dir/reports/security"
mkdir -p "$report_dir"

scan_args=(
  detect
  --source=/repo
  --config=/repo/.gitleaks.toml
  --report-format=json
  --report-path=/reports/gitleaks-report.json
  --redact
  --no-banner
)
if [[ "$nightly" != true ]]; then
  scan_args+=(--log-opts "origin/main..HEAD")
fi

docker run --rm \
  --volume "$source_dir:/repo" \
  --volume "$report_dir:/reports" \
  --workdir /repo \
  "$gitleaks_image" \
  "${scan_args[@]}"
