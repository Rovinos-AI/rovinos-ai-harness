// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "./primitives.js";

/** A detected range in the original text, measured in UTF-16 code units. */
export const DetectionSchema = z
  .object({
    entityType: Code,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    detectorId: Code,
  })
  .strict()
  .refine((detection) => detection.end > detection.start);

/** Schema-typed detector output; end is exclusive. */
export type Detection = z.infer<typeof DetectionSchema>;

/** Custom detector configuration; runtime compilation additionally screens regex safety. */
export const CustomDetectorSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_]{1,40}$/u),
    pattern: z.string().min(1).max(1024),
    flags: z
      .string()
      .max(4)
      .refine((flags) => Array.from(flags).every((flag) => ["i", "m", "s", "u"].includes(flag)))
      .optional(),
    validator: z.enum(["luhn", "mod97"]).optional(),
  })
  .strict();

/** Validated custom detector configuration. */
export type CustomDetector = z.infer<typeof CustomDetectorSchema>;

/** Text accepted by synchronous detectors. */
export const DetectorTextSchema = z.string();
