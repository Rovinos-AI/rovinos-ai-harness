// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code, Id } from "../primitives.js";

/** A status reported by one environment diagnostic. */
export const DoctorStatusSchema = z.enum(["ok", "warn", "fail"]);

/** Status and safe detail returned by a `DoctorCheck`. */
export const DoctorCheckStatusSchema = z
  .object({
    status: DoctorStatusSchema,
    code: Code,
    detail: z.union([Id, Code]).optional(),
  })
  .strict();

/** One safe diagnostic result returned by `harness doctor`. */
export const DoctorCheckResultSchema = z
  .object({
    id: Code,
    ...DoctorCheckStatusSchema.shape,
  })
  .strict();

/** The JSON result array returned by `harness doctor`. */
export const DoctorResultsSchema = z.array(DoctorCheckResultSchema);

/** Inferred status of an individual doctor check. */
export type DoctorStatus = z.infer<typeof DoctorStatusSchema>;
/** Inferred result returned by one doctor check before adding its identifier. */
export type DoctorCheckStatus = z.infer<typeof DoctorCheckStatusSchema>;
/** Inferred, value-safe result of an individual doctor check. */
export type DoctorCheckResult = z.infer<typeof DoctorCheckResultSchema>;
