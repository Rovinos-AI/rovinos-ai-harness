// SPDX-License-Identifier: Apache-2.0
// Integration suites that start Docker Compose stacks. The `integration-compose` Vitest project runs
// them one file at a time: parallel stacks starve the CI agent's Docker VM (2026-10-21, #523).

/** Repository-relative paths of the integration suites that start Compose stacks. */
export const composeIntegrationSuites = [
  "packages/sandbox/egress-proxy/src/proxy.int.test.ts",
  "packages/sandbox/runner/src/server.int.test.ts",
  "scripts/ci/docker-image.int.test.ts",
  "scripts/collector/validate.int.test.ts",
  "scripts/compose/presidio.int.test.ts",
  "scripts/compose/prod-like.int.test.ts",
  "test/e2e-skeleton.int.test.ts",
  "test/network-isolation.int.test.ts",
] as const;
