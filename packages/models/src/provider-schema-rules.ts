// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const providerIdSchema = z.enum(["anthropic", "azure_openai", "bedrock", "openai", "vertex"]);

const providerSchemaRuleSchema = z
  .object({
    allowedKeywords: z.array(z.string().min(1)),
    requireAdditionalPropertiesFalse: z.boolean(),
    requireAllProperties: z.boolean(),
    unsupportedKeywords: z.array(z.string().min(1)),
  })
  .strict();

/** Provider identifiers with schema-lowering rules. */
export type ProviderId = z.infer<typeof providerIdSchema>;

/** Inferred JSON Schema compatibility policy for one provider. */
export type ProviderSchemaRule = z.infer<typeof providerSchemaRuleSchema>;

const commonKeywords = [
  "additionalProperties",
  "anyOf",
  "description",
  "enum",
  "items",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "title",
  "type",
];

const openAiKeywords = [
  ...commonKeywords,
  "maximum",
  "maxLength",
  "minimum",
  "minLength",
  "pattern",
];

const openAiSchemaRule = providerSchemaRuleSchema.parse({
  allowedKeywords: openAiKeywords,
  requireAdditionalPropertiesFalse: true,
  requireAllProperties: true,
  unsupportedKeywords: ["default", "format", "oneOf"],
});

const conservativeToolRule = providerSchemaRuleSchema.parse({
  allowedKeywords: commonKeywords,
  requireAdditionalPropertiesFalse: false,
  requireAllProperties: false,
  unsupportedKeywords: [
    "default",
    "format",
    "maximum",
    "maxLength",
    "minimum",
    "minLength",
    "oneOf",
    "pattern",
  ],
});

const vertexSchemaRule = providerSchemaRuleSchema.parse({
  allowedKeywords: [
    ...commonKeywords,
    "format",
    "maximum",
    "minimum",
    "oneOf",
    "prefixItems",
  ],
  requireAdditionalPropertiesFalse: false,
  requireAllProperties: false,
  unsupportedKeywords: ["default", "maxLength", "minLength", "pattern"],
});

/** Provider schema subsets are conservative; verify against current provider docs before changing. */
export const PROVIDER_SCHEMA_RULES: Readonly<Record<ProviderId, ProviderSchemaRule>> = {
  anthropic: conservativeToolRule,
  azure_openai: openAiSchemaRule,
  bedrock: conservativeToolRule,
  openai: openAiSchemaRule,
  vertex: vertexSchemaRule,
};

/**
 * Looks up the compatibility rules for a provider identifier.
 *
 * @param provider - Provider id to look up.
 * @returns The provider rules, or `undefined` when no rules are registered.
 */
export function providerSchemaRules(provider: string): ProviderSchemaRule | undefined {
  const result = providerIdSchema.safeParse(provider);
  return result.success ? PROVIDER_SCHEMA_RULES[result.data] : undefined;
}
