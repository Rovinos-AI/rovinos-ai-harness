#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

compose=(docker compose \
  --env-file infra/collector/VERSION \
  -f infra/compose/docker-compose.test.yml)
"${compose[@]}" up -d --wait --pull=missing
