// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Sandbox-specific options with unsafe local execution disabled by default. */
export const SandboxConfigSchema = z
  .object({
    allowUnsafeInProcess: z.boolean().optional(),
  })
  .strict()
  .prefault({});
