// SPDX-License-Identifier: Apache-2.0
// Control-plane approval-view settings are owned by task 18.4.
import { z } from "zod";

/** Configuration for control-plane approval views and audited reveal. */
export const ControlPlaneConfigSchema = z
  .object({
    allowReveal: z.boolean().default(false),
  })
  .strict()
  .default({ allowReveal: false });

/** Inferred control-plane configuration. */
export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;
