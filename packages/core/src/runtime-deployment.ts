// SPDX-License-Identifier: Apache-2.0
import { DeploymentConfigSchema, HarnessError } from "@harness/schemas";
import type { DeploymentConfig, StoreConfig, VaultConfig } from "@harness/schemas";

/** Startup error for a topology that cannot meet its configured deployment mode. */
export class DeploymentStartupError extends HarnessError {
  readonly code: "deployment_requires_postgres" | "deployment_single_instance_violation";

  constructor(code: "deployment_requires_postgres" | "deployment_single_instance_violation") {
    super(code);
    this.code = code;
  }
}

/** Validates that multi-instance topology uses shared durable Postgres adapters. */
export function validateDeploymentTopology(
  config: {
    readonly deployment?: DeploymentConfig;
    readonly store?: StoreConfig;
    readonly vault?: VaultConfig;
  },
  queueConfigured = false,
): void {
  const deployment = DeploymentConfigSchema.parse(config.deployment ?? {});
  if (
    deployment.mode === "multi" &&
    (config.store?.dialect !== "postgres" ||
      config.vault?.backend !== "postgres" ||
      !queueConfigured)
  ) {
    throw new DeploymentStartupError("deployment_requires_postgres");
  }
}
