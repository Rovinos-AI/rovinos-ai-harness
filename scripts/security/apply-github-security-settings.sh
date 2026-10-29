#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

usage() {
  printf 'Usage: %s (--dry-run | --apply)\n' "${0##*/}" >&2
}

mode=""
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

security_payload=$(cat <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": {
      "status": "enabled"
    },
    "secret_scanning_push_protection": {
      "status": "enabled"
    }
  }
}
JSON
)

if [[ "$mode" == "--dry-run" ]]; then
  cat <<JSON
{
  "requests": [
    {
      "method": "PATCH",
      "endpoint": "repos/{owner}/{repo}",
      "payload": $security_payload
    },
    {
      "method": "PUT",
      "endpoint": "repos/{owner}/{repo}/vulnerability-alerts",
      "payload": null
    },
    {
      "method": "PUT",
      "endpoint": "repos/{owner}/{repo}/automated-security-fixes",
      "payload": null
    },
    {
      "method": "PUT",
      "endpoint": "repos/{owner}/{repo}/vulnerability-reporting",
      "payload": null
    }
  ]
}
JSON
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  printf 'The gh CLI is required to apply repository security settings.\n' >&2
  exit 127
fi

gh api -X PATCH 'repos/{owner}/{repo}' --input - <<<"$security_payload" >/dev/null
gh api -X PUT 'repos/{owner}/{repo}/vulnerability-alerts' >/dev/null
gh api -X PUT 'repos/{owner}/{repo}/automated-security-fixes' >/dev/null
gh api -X PUT 'repos/{owner}/{repo}/vulnerability-reporting' >/dev/null
