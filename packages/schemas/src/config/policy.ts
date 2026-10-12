// SPDX-License-Identifier: Apache-2.0
// Policy configuration is owned by task 17.1.
import { z } from "zod";

/** Policy engine configuration, including the path to its policy document. */
export const PolicyConfigSchema = z
  .object({
    file: z.string().min(1).optional(),
  })
  .strict()
  .prefault({});

/** Inferred policy file configuration. */
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
