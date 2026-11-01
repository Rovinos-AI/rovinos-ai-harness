#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
exec node --experimental-strip-types --disable-warning=ExperimentalWarning \
  scripts/security/verify-image.ts "$@"
