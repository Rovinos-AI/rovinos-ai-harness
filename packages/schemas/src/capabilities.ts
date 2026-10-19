// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { ModelRefSchema, type ModelRef } from "./messages.js";

/** Declares the provider capabilities used when building model requests. */
export const CapabilitiesSchema = z
  .object({
    structuredOutput: z.enum(["native", "tool", "json_mode", "none"]),
    forcedToolChoice: z.boolean(),
    parallelToolCalls: z.boolean(),
    maxContextTokens: z.number().int().nonnegative(),
    opaqueRoundTrip: z.boolean(),
  })
  .strict();

/** Inferred provider capability set. */
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

const CapabilitiesOverridesSchema = CapabilitiesSchema.partial().strict();

const defaultCapabilities: Capabilities = {
  structuredOutput: "none",
  forcedToolChoice: false,
  parallelToolCalls: false,
  maxContextTokens: 0,
  opaqueRoundTrip: false,
};

const providerDefaults: ReadonlyMap<string, Capabilities> = new Map([
  [
    "anthropic",
    {
      ...defaultCapabilities,
      structuredOutput: "tool",
      forcedToolChoice: true,
      opaqueRoundTrip: true,
    },
  ],
  [
    "bedrock",
    {
      ...defaultCapabilities,
      structuredOutput: "tool",
      forcedToolChoice: true,
      opaqueRoundTrip: true,
    },
  ],
  [
    "openai",
    {
      ...defaultCapabilities,
      structuredOutput: "native",
      forcedToolChoice: true,
      parallelToolCalls: true,
      opaqueRoundTrip: true,
    },
  ],
  [
    "vertex",
    {
      ...defaultCapabilities,
      structuredOutput: "native",
    },
  ],
]);

/**
 * Returns provider defaults merged with explicit configuration overrides.
 *
 * @param ref - Provider and model to look up.
 * @param overrides - Capability values configured for this model.
 * @returns Merged capabilities and whether configuration supplied an override.
 */
export function lookupCapabilities(
  ref: ModelRef,
  overrides: Partial<Capabilities> = {},
): { readonly capabilities: Capabilities; readonly source: "config" | "default" } {
  const modelRef = ModelRefSchema.parse(ref);
  const parsedOverrides = CapabilitiesOverridesSchema.parse(overrides);
  const base = providerDefaults.get(modelRef.provider) ?? defaultCapabilities;
  const hasOverrides = Object.values(parsedOverrides).some((value) => value !== undefined);

  return {
    capabilities: {
      structuredOutput: parsedOverrides.structuredOutput ?? base.structuredOutput,
      forcedToolChoice: parsedOverrides.forcedToolChoice ?? base.forcedToolChoice,
      parallelToolCalls: parsedOverrides.parallelToolCalls ?? base.parallelToolCalls,
      maxContextTokens: parsedOverrides.maxContextTokens ?? base.maxContextTokens,
      opaqueRoundTrip: parsedOverrides.opaqueRoundTrip ?? base.opaqueRoundTrip,
    },
    source: hasOverrides ? "config" : "default",
  };
}
