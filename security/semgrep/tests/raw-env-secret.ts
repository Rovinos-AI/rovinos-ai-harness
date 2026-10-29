// SPDX-License-Identifier: Apache-2.0
// ruleid: harness.secret-env-outside-resolver
const rawSecret = process.env.HARNESS_API_KEY;
// ruleid: harness.secret-env-outside-resolver
const rawToken = process.env["ACCESS_TOKEN"];
// ok: harness.secret-env-outside-resolver
const logLevel = process.env.LOG_LEVEL;
// ok: harness.secret-env-outside-resolver
delete process.env.HARNESS_API_KEY;
// ok: harness.secret-env-outside-resolver
process.env.ACCESS_TOKEN = replacementToken;

function runnerTokenFromEnvironment(): string | undefined {
  // ruleid: harness.secret-env-outside-resolver
  return process.env.SANDBOX_RUNNER_TOKEN;
}
