// SPDX-License-Identifier: Apache-2.0
// PII configuration is owned by tasks 13.1 and 13.2.
import { z } from "zod";
import { CustomDetectorSchema } from "../pii-detection.js";
import { PiiPolicySchema } from "../pii-policy.js";

export const PiiConfigSchema = PiiPolicySchema.safeExtend({
  custom: z.array(CustomDetectorSchema).optional(),
}).prefault({});

/** Validated PII configuration. */
export type PiiConfig = z.infer<typeof PiiConfigSchema>;
