// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Code } from "./primitives.js";

export const PiiEntitySchema = z.union([
  z.enum([
    "email",
    "phone",
    "credit_card",
    "iban",
    "national_id",
    "ip_address",
    "person_name",
    "location",
    "api_key",
    "url_credentials",
  ]),
  z.string().regex(/^custom_[a-z0-9_]{1,40}$/u),
]);

/** Entity categories supported by the PII policy. */
export type PiiEntity = z.infer<typeof PiiEntitySchema>;

export const PiiBoundarySchema = z.enum([
  "model_input",
  "tool_input",
  "tool_output",
  "storage",
  "ui",
]);

/** Trust boundary where the entity was found. */
export type PiiBoundary = z.infer<typeof PiiBoundarySchema>;

export const PiiActionSchema = z.enum(["tokenize", "redact", "block", "allow"]);

/** Action to apply to a detected entity. */
export type PiiAction = z.infer<typeof PiiActionSchema>;

export const DestinationSchema = z.union([
  z.enum(["hosted", "local", "any"]),
  z.object({ tool: Code }).strict(),
]);

/** Destination receiving the entity. */
export type Destination = z.infer<typeof DestinationSchema>;

const selectorSchema = <Value extends z.ZodType>(valueSchema: Value) =>
  z.union([z.array(valueSchema), z.literal("*")]);

export const PiiRuleSchema = z
  .object({
    entities: selectorSchema(PiiEntitySchema),
    boundaries: selectorSchema(PiiBoundarySchema),
    destinations: selectorSchema(DestinationSchema),
    action: PiiActionSchema,
  })
  .strict();

/** One ordered rule in a PII policy. */
export type PiiRule = z.infer<typeof PiiRuleSchema>;

function addPolicyIssue(context: z.RefinementCtx, code: string, path: (string | number)[]): void {
  context.addIssue({
    code: "custom",
    message: code,
    params: { errorCode: code },
    path,
  });
}

export const PiiPolicySchema = z
  .object({
    defaultAction: PiiActionSchema.default("tokenize"),
    rules: z.array(PiiRuleSchema).default([]),
  })
  .strict()
  .superRefine((policy, context) => {
    policy.rules.forEach((rule, ruleIndex) => {
      if (rule.action !== "allow") {
        return;
      }

      if (rule.entities === "*") {
        addPolicyIssue(context, "pii_policy_allow_all_entities", ["rules", ruleIndex, "entities"]);
      }

      if (rule.boundaries === "*" || rule.boundaries.includes("storage")) {
        addPolicyIssue(context, "pii_policy_storage_allow", ["rules", ruleIndex, "boundaries"]);
      }

      if (
        rule.entities !== "*" &&
        rule.entities.some((entity) => entity === "api_key" || entity === "credit_card") &&
        (rule.destinations === "*" ||
          rule.destinations.length === 0 ||
          rule.destinations.some((destination) => typeof destination === "string"))
      ) {
        addPolicyIssue(context, "pii_policy_secret_allow_destination", [
          "rules",
          ruleIndex,
          "destinations",
        ]);
      }
    });
  });

/** Validated PII policy with default action and ordered rules. */
export type PiiPolicy = z.infer<typeof PiiPolicySchema>;
