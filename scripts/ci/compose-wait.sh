#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

compose=(docker compose \
  --env-file infra/collector/VERSION \
  -f infra/compose/docker-compose.test.yml)
"${compose[@]}" up -d --wait --pull=missing

postgres_id="$("${compose[@]}" ps --quiet postgres)"
postgres_ip="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$postgres_id")"
if [[ -z "$postgres_ip" ]]; then
  printf 'PostgreSQL Compose address is unavailable\n' >&2
  exit 1
fi
printf '##vso[task.setvariable variable=TEST_POSTGRES_URL]postgresql://harness@%s:5432/harness\n' "$postgres_ip"
