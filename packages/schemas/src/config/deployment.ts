// SPDX-License-Identifier: Apache-2.0
// Deployment configuration is owned by task 24.6.
import { z } from "zod";

/** Deployment topology used to select single- or multi-instance safeguards. */
export const DeploymentConfigSchema = z
  .object({
    mode: z.enum(["single", "multi"]).default("single"),
  })
  .strict()
  .prefault({});

/** Inferred deployment topology configuration. */
export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;
