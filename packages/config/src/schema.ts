// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  ModelsConfigSchema,
  ControlPlaneConfigSchema,
  DeploymentConfigSchema,
  ElicitationConfigSchema,
  CliConfigSchema,
  KeysConfigSchema,
  PiiConfigSchema,
  PolicyConfigSchema,
  QuotasConfigSchema,
  RunConfigSchema,
  RolesConfigSchema,
  SandboxConfigSchema,
  ServersConfigSchema,
  StoreConfigSchema,
  TelemetryConfigSchema,
  VaultConfigSchema,
} from "@harness/schemas";

/** The complete, strictly validated harness configuration. */
export const HarnessConfigSchema = z
  .object({
    run: RunConfigSchema,
    roles: RolesConfigSchema,
    quotas: QuotasConfigSchema,
    store: StoreConfigSchema,
    keys: KeysConfigSchema.optional(),
    models: ModelsConfigSchema,
    servers: ServersConfigSchema,
    policy: PolicyConfigSchema,
    pii: PiiConfigSchema,
    vault: VaultConfigSchema,
    telemetry: TelemetryConfigSchema,
    sandbox: SandboxConfigSchema,
    elicitation: ElicitationConfigSchema,
    controlPlane: ControlPlaneConfigSchema.optional(),
    deployment: DeploymentConfigSchema,
    cli: CliConfigSchema.optional(),
  })
  .strict();

/** The inferred configuration returned by {@link HarnessConfigSchema}. */
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
