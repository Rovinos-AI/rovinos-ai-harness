// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DeploymentStartupError, validateDeploymentTopology } from "./runtime-deployment.js";

describe("validateDeploymentTopology", () => {
  const cases: readonly {
    readonly config: Parameters<typeof validateDeploymentTopology>[0];
    readonly supported: boolean;
  }[] = [
    { config: {}, supported: true },
    { config: { deployment: { mode: "single" } }, supported: true },
    {
      config: {
        deployment: { mode: "multi" },
        store: { dialect: "postgres" },
        vault: { backend: "postgres" },
      },
      supported: true,
    },
    {
      config: {
        deployment: { mode: "multi" },
        store: { dialect: "sqlite" },
        vault: { backend: "postgres" },
      },
      supported: false,
    },
    {
      config: {
        deployment: { mode: "multi" },
        store: { dialect: "postgres" },
        vault: { backend: "sqlite" },
      },
      supported: false,
    },
    { config: { deployment: { mode: "multi" } }, supported: false },
  ];

  it.each(cases)("validates topology $config", ({ config, supported }) => {
    if (supported) {
      expect(() => validateDeploymentTopology(config, config.deployment?.mode === "multi")).not.toThrow();
    } else {
      expect(() => validateDeploymentTopology(config, config.store?.dialect === "postgres")).toThrow(
        expect.objectContaining({ code: "deployment_requires_postgres" }),
      );
    }
  });

  it("requires a durable queue for multi-instance mode", () => {
    expect(() =>
      validateDeploymentTopology({
        deployment: { mode: "multi" },
        store: { dialect: "postgres" },
        vault: { backend: "postgres" },
      }),
    ).toThrow(expect.objectContaining({ code: "deployment_requires_postgres" }));
  });

  it("provides a typed refusal for a second live SQLite instance", () => {
    expect(
      new DeploymentStartupError("deployment_single_instance_violation"),
    ).toMatchObject({ code: "deployment_single_instance_violation" });
  });
});
