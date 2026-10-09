// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  ModelsConfigSchema,
  PiiConfigSchema,
  PolicyConfigSchema,
  RunConfigSchema,
  SandboxConfigSchema,
  ServerConfigSchema,
  StoreConfigSchema,
  TelemetryConfigSchema,
} from "@harness/schemas";

/** The complete, strictly validated harness configuration. */
export const HarnessConfigSchema = z
  .object({
    run: RunConfigSchema,
    store: StoreConfigSchema,
    models: ModelsConfigSchema,
    servers: z.array(ServerConfigSchema).default([]),
    policy: PolicyConfigSchema,
    pii: PiiConfigSchema,
    telemetry: TelemetryConfigSchema,
    sandbox: SandboxConfigSchema,
  })
  .strict();

/** The inferred configuration returned by {@link HarnessConfigSchema}. */
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
