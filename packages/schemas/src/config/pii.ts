// SPDX-License-Identifier: Apache-2.0
// PII configuration is owned by tasks 13.1, 13.2, and 13.5.
import { z } from "zod";
import { CustomDetectorSchema } from "../pii-detection.js";
import { PiiPolicySchema } from "../pii-policy.js";
import { Code } from "../primitives.js";

/** Validates an RFC 6901 JSON Pointer, including valid `~0` and `~1` escapes. */
export const JsonPointerSchema = z.string().refine(
  (pointer) =>
    pointer === "" ||
    (pointer.startsWith("/") &&
      pointer
        .slice(1)
        .split("/")
        .every((segment) => !/~(?![01])/u.test(segment))),
  { message: "Invalid JSON pointer" },
);

/** A JSON Pointer selecting a value within tool arguments. */
export type JsonPointer = z.infer<typeof JsonPointerSchema>;

/** Tool arguments permitted to receive resolved raw values. */
export const PiiDetokenizeRuleSchema = z
  .object({
    toolId: Code,
    args: z.array(
      JsonPointerSchema.refine((pointer) => pointer !== "", {
        message: "A tool argument pointer must select a value",
      }),
    ),
    onUnresolvable: z.enum(["fail", "leave"]).default("fail"),
  })
  .strict();

/** Inferred detokenization allowlist entry. */
export type PiiDetokenizeRule = z.infer<typeof PiiDetokenizeRuleSchema>;

export const PiiConfigSchema = PiiPolicySchema.safeExtend({
  enabled: z.boolean().default(true),
  custom: z.array(CustomDetectorSchema).optional(),
  detokenize: z
    .array(PiiDetokenizeRuleSchema)
    .superRefine((rules, context) => {
      const seenToolIds = new Set<string>();
      for (const [index, rule] of rules.entries()) {
        if (seenToolIds.has(rule.toolId)) {
          context.addIssue({
            code: "custom",
            path: [index, "toolId"],
            message: "Duplicate toolId",
            params: { errorCode: "duplicate_tool_id" },
          });
        } else {
          seenToolIds.add(rule.toolId);
        }
      }
    })
    .optional(),
}).prefault({});

/** Validated PII configuration. */
export type PiiConfig = z.infer<typeof PiiConfigSchema>;
