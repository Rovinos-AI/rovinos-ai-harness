// SPDX-License-Identifier: Apache-2.0
// Policy configuration is owned by task 17.1.
import { z } from "zod";
import { SecretRefSchema } from "../secret-ref.js";

const ApprovalWebhookUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Approval webhook URLs must use HTTPS or localhost HTTP without credentials.",
    });
  }
});

/** Approval escalation notification destination configuration. */
export const ApprovalNotifierConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("log") }).strict(),
  z
    .object({
      kind: z.literal("webhook"),
      url: ApprovalWebhookUrlSchema,
      secretRef: SecretRefSchema,
      timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    })
    .strict(),
]);

/** Approval expiry and escalation configuration. */
export const ApprovalConfigSchema = z
  .object({
    notifier: ApprovalNotifierConfigSchema.default({ kind: "log" }),
    allowInsecureLocalhost: z.boolean().default(false),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.notifier.kind === "webhook" &&
      new URL(config.notifier.url).protocol === "http:" &&
      !config.allowInsecureLocalhost
    ) {
      context.addIssue({
        code: "custom",
        path: ["notifier", "url"],
        message: "localhost HTTP requires allowInsecureLocalhost.",
      });
    }
  });

/** Policy engine configuration, including the path to its policy document. */
export const PolicyConfigSchema = z
  .object({
    file: z.string().min(1).optional(),
    approvals: ApprovalConfigSchema.optional(),
  })
  .strict()
  .prefault({});

/** Inferred policy file configuration. */
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
