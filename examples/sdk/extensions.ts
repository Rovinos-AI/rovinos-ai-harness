// SPDX-License-Identifier: Apache-2.0
import {
  CodeSchema,
  ProviderResultSchema,
  createHarness,
  defineTool,
} from "@rovinos/sdk";
import type { ExtensionDefinition, Harness, ProviderAdapter } from "@rovinos/sdk";
import { z } from "zod";

const ConfigurationSchema = z.object({ maxResults: z.number().int().min(1).max(5) }).strict();
const SearchInputSchema = z.object({ query: z.string().trim().min(1).max(200) }).strict();
const SearchOutputSchema = z
  .object({ matches: z.array(z.string().max(200)).max(5) })
  .strict();

const provider: ProviderAdapter = {
  provider: CodeSchema.parse("sample.provider"),
  kind: "openai_compatible",
  complete(_request, context) {
    context.signal.throwIfAborted();
    return Promise.resolve(
      ProviderResultSchema.parse({
        parts: [{ type: "text", text: "Synthetic custom provider response." }],
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: CodeSchema.parse("stop"),
        latencyMs: 0,
      }),
    );
  },
};

const searchExtension: ExtensionDefinition<typeof ConfigurationSchema> = {
  manifest: {
    id: "sample.search",
    version: "1.0.0",
    sdkRange: ">=0.3.0 <0.4.0",
    schemaVersion: 1,
    capabilities: {
      required: [
        { kind: "tools.contribute", names: ["search"] },
        { kind: "providers.contribute", providers: ["sample.provider"] },
      ],
      optional: [],
    },
  },
  configSchema: ConfigurationSchema,
  createContributions: ({ maxResults }) => ({
    tools: [
      defineTool({
        name: "search",
        description: "Search the synthetic source.",
        inputSchema: SearchInputSchema,
        outputSchema: SearchOutputSchema,
        execute({ query }, context) {
          context.signal.throwIfAborted();
          return Promise.resolve({
            matches: [`${query.slice(0, 200)} (${String(maxResults)} max)`],
          });
        },
      }),
    ],
    providers: [provider],
  }),
};

/** Example consumer composition using only the public SDK and Zod contracts. */
export function createExampleHarness(configPath: string): Promise<Harness> {
  return createHarness({
    configPath,
    extensions: [
      {
        namespace: "sample",
        definition: searchExtension,
        config: { maxResults: 3 },
        grants: [
          { kind: "tools.contribute", names: ["search"] },
          { kind: "providers.contribute", providers: ["sample.provider"] },
        ],
      },
    ],
  });
}
