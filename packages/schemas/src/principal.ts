// SPDX-License-Identifier: Apache-2.0
import type { z } from "zod";
import { Code } from "./primitives.js";

/** A validated actor identity recorded on run and approval events. */
export const Principal = Code.refine(
  (value) =>
    /^(?:token|cli)\.[a-z0-9_.-]+$/u.test(value) ||
    value === "eval.simulated" ||
    value === "system.sweeper",
);

/** Inferred principal identity. */
export type Principal = z.infer<typeof Principal>;
