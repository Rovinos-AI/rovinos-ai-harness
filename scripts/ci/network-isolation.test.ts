// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { readComposeNetworkConfig } from "./network-isolation.js";

it("limits the rendered Compose egress network to the collector", () => {
  const config = readComposeNetworkConfig();

  expect(config.networks.internal?.internal).toBe(true);
  expect(config.networks.egress?.internal).not.toBe(true);
  expect(Object.keys(config.services.harness?.networks ?? {}).sort()).toEqual(["internal"]);
  expect(Object.keys(config.services["otel-collector"]?.networks ?? {}).sort()).toEqual([
    "egress",
    "internal",
  ]);
  expect(Object.keys(config.services.postgres?.networks ?? {}).sort()).toEqual(["internal"]);
  expect(
    Object.entries(config.services)
      .filter(([, service]) => Object.hasOwn(service.networks ?? {}, "egress"))
      .map(([name]) => name),
  ).toEqual(["otel-collector"]);
});
