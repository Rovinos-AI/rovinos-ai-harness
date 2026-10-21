#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# COMPOSE_PROJECT_NAME defaults to a unique harness-local name; CI sets a build-specific name.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-harness-local-$(date +%s)-$$}"

compose=(docker compose \
  --env-file infra/collector/VERSION \
  -f infra/compose/docker-compose.test.yml)
"${compose[@]}" up -d --wait --pull=missing
