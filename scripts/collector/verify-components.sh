#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf 'Usage: %s\n' "$0" >&2
  exit 2
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
collector_directory="$(cd -- "$script_directory/../../infra/collector" && pwd)"
image="$(sed -n 's/^OTEL_COLLECTOR_IMAGE=//p' "$collector_directory/VERSION")"

if [[ ! "$image" =~ ^otel/opentelemetry-collector-contrib:[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]{64}$ ]]; then
  printf 'Invalid collector image in infra/collector/VERSION\n' >&2
  exit 2
fi

if ! components="$(docker run --pull=never --rm "$image" components)"; then
  printf 'Could not inspect required components in the pinned collector image. See infra/collector/builder.yaml for the documented fallback.\n' >&2
  exit 1
fi

has_component() {
  local group="$1"
  local name="$2"

  awk -v expected_group="$group" -v expected_name="$name" '
    /^[[:alnum:]_]+:$/ {
      section = $0
      sub(/:$/, "", section)
      next
    }
    section == expected_group && $0 ~ "^[[:space:]]+- name: " expected_name "$" {
      found = 1
    }
    END {
      exit !found
    }
  ' <<< "$components"
}

for component in datadog azuredataexplorer file debug; do
  if ! has_component exporters "$component"; then
    printf 'Pinned collector image is missing exporter %s. See infra/collector/builder.yaml for the documented fallback.\n' "$component" >&2
    exit 1
  fi
done

for component in transform filter memory_limiter batch; do
  if ! has_component processors "$component"; then
    printf 'Pinned collector image is missing processor %s. See infra/collector/builder.yaml for the documented fallback.\n' "$component" >&2
    exit 1
  fi
done
