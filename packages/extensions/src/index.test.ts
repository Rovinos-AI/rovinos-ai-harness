// SPDX-License-Identifier: Apache-2.0
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ExtensionDefinitionSchema,
  type ExtensionDefinition,
  type ExtensionRegistration,
} from "@rovinos/sdk";
import { z } from "zod";
import { composeExtensions, defineExtension } from "./index.js";

const configSchema = z.object({ endpoint: z.url() });

function makeExtension() {
  return {
    manifest: {
      id: "example.lookup",
      version: "1.0.0",
      sdkRange: ">=0.3.0 <0.4.0",
      schemaVersion: 1,
      capabilities: {
        required: [],
        optional: [],
      },
    },
    configSchema,
    createContributions: (config) => {
      expectTypeOf(config).toEqualTypeOf<{ endpoint: string }>();
      return {};
    },
  } satisfies ExtensionDefinition<typeof configSchema>;
}

function makeRegistration(namespace: string): ExtensionRegistration {
  return {
    namespace,
    definition: makeExtension(),
    grants: [],
  };
}

describe("extension authoring helpers", () => {
  it("preserves config inference and validates with the SDK definition schema", () => {
    const definition = defineExtension(makeExtension());

    expect(ExtensionDefinitionSchema.safeParse(definition).success).toBe(true);
    expectTypeOf<typeof definition.createContributions>()
      .parameter(0)
      .toEqualTypeOf<{ endpoint: string }>();
  });

  it("rejects invalid extension identities in the same way as direct SDK validation", () => {
    const invalidDefinition = {
      ...makeExtension(),
      manifest: { ...makeExtension().manifest, id: "invalid identity" },
    } satisfies ExtensionDefinition<typeof configSchema>;

    const helperResult = ExtensionDefinitionSchema.safeParse(invalidDefinition);
    let helperError: string[] = [];
    try {
      defineExtension(invalidDefinition);
    } catch (error) {
      helperError =
        error instanceof z.ZodError ? error.issues.map(({ path }) => path.join(".")) : [];
    }

    expect(helperResult.success).toBe(false);
    expect(helperError).toEqual(
      helperResult.success ? [] : helperResult.error.issues.map(({ path }) => path.join(".")),
    );
  });

  it("composes registration groups without adding grants or mutating inputs", () => {
    const first = makeRegistration("lookup");
    const second = makeRegistration("summarize");
    const firstGroup: readonly ExtensionRegistration[] = [first];
    const combined = composeExtensions(firstGroup, [], [second]);

    expect(combined).toEqual([first, second]);
    expect(combined[0]?.grants).toEqual([]);
    expect(firstGroup).toEqual([first]);
  });
});
