#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

docker compose \
  --env-file infra/collector/VERSION \
  -f infra/compose/docker-compose.test.yml \
  up -d --wait --pull=missing
