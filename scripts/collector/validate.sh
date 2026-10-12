#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  printf 'Usage: %s <profile>\n' "$0" >&2
  exit 2
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
collector_directory="$(cd -- "$script_directory/../../infra/collector" && pwd)"
image="$(sed -n 's/^OTEL_COLLECTOR_IMAGE=//p' "$collector_directory/VERSION")"

if [[ ! "$image" =~ ^otel/opentelemetry-collector-contrib:[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]{64}$ ]]; then
  printf 'Invalid collector image in infra/collector/VERSION\n' >&2
  exit 2
fi

profile_file="profile-$1.yaml"
if [[ ! -f "$collector_directory/$profile_file" ]]; then
  printf 'Unknown collector profile: %s\n' "$1" >&2
  exit 2
fi

docker run --rm \
  --volume "$collector_directory:/etc/otel:ro" \
  "$image" validate \
  --config=/etc/otel/base.yaml \
  --config="/etc/otel/$profile_file"
