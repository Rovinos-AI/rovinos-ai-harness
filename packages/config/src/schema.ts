// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  ModelsConfigSchema,
  PiiConfigSchema,
  PolicyConfigSchema,
  RunConfigSchema,
  RolesConfigSchema,
  SandboxConfigSchema,
  ServersConfigSchema,
  StoreConfigSchema,
  TelemetryConfigSchema,
} from "@harness/schemas";

/** The complete, strictly validated harness configuration. */
export const HarnessConfigSchema = z
  .object({
    run: RunConfigSchema,
    roles: RolesConfigSchema,
    store: StoreConfigSchema,
    models: ModelsConfigSchema,
    servers: ServersConfigSchema,
    policy: PolicyConfigSchema,
    pii: PiiConfigSchema,
    telemetry: TelemetryConfigSchema,
    sandbox: SandboxConfigSchema,
  })
  .strict();

/** The inferred configuration returned by {@link HarnessConfigSchema}. */
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
