#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

usage() {
  printf 'Usage: %s [--dry-run]\n' "${0##*/}" >&2
}

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--dry-run" ) ]]; then
  usage
  exit 2
fi

payload='{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Azure Pipelines / Rovinos AI Harness CI",
      "DCO"
    ]
  },
  "required_pull_request_reviews": {
    "required_approving_review_count": 1
  },
  "enforce_admins": true,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}'

if [[ $# -eq 1 ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

gh api -X PUT repos/rovinoscr/rovinos-ai-harness/branches/main/protection --input - <<<"$payload"
