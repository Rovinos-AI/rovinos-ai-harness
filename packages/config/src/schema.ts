// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  ModelsConfigSchema,
  KeysConfigSchema,
  PiiConfigSchema,
  PolicyConfigSchema,
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
    store: StoreConfigSchema,
    keys: KeysConfigSchema.optional(),
    models: ModelsConfigSchema,
    servers: ServersConfigSchema,
    policy: PolicyConfigSchema,
    pii: PiiConfigSchema,
    vault: VaultConfigSchema,
    telemetry: TelemetryConfigSchema,
    sandbox: SandboxConfigSchema,
  })
  .strict();

/** The inferred configuration returned by {@link HarnessConfigSchema}. */
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
