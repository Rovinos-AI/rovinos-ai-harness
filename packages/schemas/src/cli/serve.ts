// SPDX-License-Identifier: Apache-2.0
// Task 20.2: JSON result for the foreground serve command.
import { z } from "zod";

/** Machine-readable status emitted when the harness serve process starts. */
export const ServeResultSchema = z
  .object({
    status: z.literal("serving"),
  })
  .strict();

/** The validated JSON result emitted by the serve command. */
export type ServeResult = z.infer<typeof ServeResultSchema>;
