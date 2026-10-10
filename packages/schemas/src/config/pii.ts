// SPDX-License-Identifier: Apache-2.0
// PII configuration is owned by task 13.1.
import { PiiPolicySchema } from "../pii-policy.js";
import type { PiiPolicy } from "../pii-policy.js";

export const PiiConfigSchema = PiiPolicySchema.prefault({});

/** Validated PII configuration. */
export type PiiConfig = PiiPolicy;
