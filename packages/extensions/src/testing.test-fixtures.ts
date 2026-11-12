// SPDX-License-Identifier: Apache-2.0
import type { ExtensionDefinition } from "@rovinos/sdk";
import { z } from "zod";

const configSchema = z.object({});

/** Return a minimal extension definition for test registrations. */
export function makeTestExtension(): ExtensionDefinition<typeof configSchema> {
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
    createContributions: () => ({}),
  };
}
