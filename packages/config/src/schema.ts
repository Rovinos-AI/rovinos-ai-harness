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
  RateLimitsConfigSchema,
  RunConfigSchema,
  RolesConfigSchema,
  SandboxConfigSchema,
  ServersConfigSchema,
  StoreConfigSchema,
  TelemetryConfigSchema,
  ToolProfilesConfigSchema,
  VaultConfigSchema,
} from "@rovinos/schemas";

/** The complete, strictly validated harness configuration. */
export const HarnessConfigSchema = z
  .object({
    run: RunConfigSchema,
    toolProfiles: ToolProfilesConfigSchema.default({}),
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
    rateLimits: RateLimitsConfigSchema,
    deployment: DeploymentConfigSchema,
    cli: CliConfigSchema.optional(),
  })
  .strict();

/** The inferred configuration returned by {@link HarnessConfigSchema}. */
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
