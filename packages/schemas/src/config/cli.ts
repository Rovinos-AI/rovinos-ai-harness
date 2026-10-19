// SPDX-License-Identifier: Apache-2.0
// CLI principal configuration is owned by task 17.9.
import { Principal } from "../principal.js";
import { z } from "zod";

/** CLI attribution configuration; CLI principals are not authenticated. */
export const CliConfigSchema = z
  .object({
    principal: Principal.refine((principal) => principal.startsWith("cli.")).optional(),
  })
  .strict();

/** Inferred CLI configuration. */
export type CliConfig = z.infer<typeof CliConfigSchema>;
