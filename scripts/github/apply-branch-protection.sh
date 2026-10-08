#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

usage() {
  printf 'Usage: %s (--dry-run | --apply) [--check <context> ...]\n' "${0##*/}" >&2
}

mode=""
checks=()

while (($# > 0)); do
  case "$1" in
    --dry-run | --apply)
      if [[ -n "$mode" ]]; then
        usage
        exit 2
      fi
      mode=$1
      shift
      ;;
    --check)
      if [[ $# -lt 2 || -z "$2" || "$2" =~ [[:cntrl:]] ]]; then
        usage
        exit 2
      fi
      checks+=("$2")
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$mode" ]]; then
  usage
  exit 2
fi

if ((${#checks[@]} == 0)); then
  required_status_checks=null
else
  contexts=""
  for check in "${checks[@]}"; do
    escaped_check=${check//\\/\\\\}
    escaped_check=${escaped_check//\"/\\\"}
    if [[ -n "$contexts" ]]; then
      contexts+=","
    fi
    contexts+="\"$escaped_check\""
  done
  required_status_checks=$(printf '{\n    "strict": true,\n    "contexts": [%s]\n  }' "$contexts")
fi

payload=$(cat <<EOF
{
  "required_status_checks": $required_status_checks,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1
  },
  "enforce_admins": false,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF
)

if [[ "$mode" == "--dry-run" ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

gh api -X PUT 'repos/{owner}/{repo}/branches/main/protection' --input - <<<"$payload"
