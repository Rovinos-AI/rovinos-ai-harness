// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  readRenderedComposeNetworkConfig,
  runNetworkIsolationCompose,
} from "../scripts/ci/network-isolation.js";

const projectName = `harness-network-isolation-${String(process.pid)}`;

it("limits the rendered Compose egress network to the collector", () => {
  const config = readRenderedComposeNetworkConfig();

  expect(config.networks.internal?.internal).toBe(true);
  expect(config.networks.egress?.internal).not.toBe(true);
  expect(Object.keys(config.services.harness?.networks ?? {}).sort()).toEqual(["internal"]);
  expect(Object.keys(config.services["otel-collector"]?.networks ?? {}).sort()).toEqual([
    "egress",
    "internal",
  ]);
  expect(Object.keys(config.services.postgres?.networks ?? {}).sort()).toEqual(["test-host"]);
  expect(
    Object.entries(config.services)
      .filter(([, service]) => Object.hasOwn(service.networks ?? {}, "egress"))
      .map(([name]) => name),
  ).toEqual(["otel-collector"]);
});

it("isolates internal clients from the egress network and public internet", async () => {
  try {
    await runNetworkIsolationCompose(projectName, [
      "up",
      "--detach",
      "--wait",
      "--pull=missing",
      "egress-probe",
      "probe-client",
      "egress-probe-client",
    ]);

    const blockedRequests = [
      "const targets = ['http://egress-probe:8080/', 'https://example.com/'];",
      "const results = await Promise.all(targets.map(async (url) => {",
      "  try {",
      "    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });",
      "    await response.body?.cancel();",
      "    return false;",
      "  } catch { return true; }",
      "}));",
      "if (results.some((blocked) => !blocked)) process.exitCode = 1;",
    ].join("\n");
    const blockedOutput = await runNetworkIsolationCompose(projectName, [
      "exec",
      "--no-TTY",
      "probe-client",
      "node",
      "-e",
      `${blockedRequests}\nif (process.exitCode !== 1) process.stdout.write('blocked');`,
    ]);
    expect(blockedOutput.trim()).toBe("blocked");

    const allowedRequest = [
      "const response = await fetch('http://egress-probe:8080/');",
      "if (response.status !== 200 || await response.text() !== 'probe') process.exitCode = 1;",
      "else process.stdout.write('reachable');",
    ].join("\n");
    const allowedOutput = await runNetworkIsolationCompose(projectName, [
      "exec",
      "--no-TTY",
      "egress-probe-client",
      "node",
      "-e",
      allowedRequest,
    ]);
    expect(allowedOutput.trim()).toBe("reachable");
  } finally {
    await runNetworkIsolationCompose(projectName, ["down", "--volumes", "--remove-orphans"]).catch(
      () => undefined,
    );
  }
}, 60_000);
