#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# Local workflow (from the repository root):
#   scripts/ci/compose-wait.sh
#   COMPOSE_PROJECT_NAME=harness-local yarn test:integration
#   COMPOSE_PROJECT_NAME=harness-local docker compose --env-file infra/collector/VERSION -f infra/compose/docker-compose.test.yml down -v --remove-orphans

# CI sets a build-specific name; local runs share the fixed name shown in the workflow above.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-harness-local}"

compose=(docker compose \
  --env-file infra/collector/VERSION \
  -f infra/compose/docker-compose.test.yml)
"${compose[@]}" up -d --wait --pull=missing
printf 'Compose project: %s\n' "$COMPOSE_PROJECT_NAME"
printf 'Stop with: COMPOSE_PROJECT_NAME=%q docker compose --env-file infra/collector/VERSION -f infra/compose/docker-compose.test.yml down -v --remove-orphans\n' \
  "$COMPOSE_PROJECT_NAME"
