// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { getConfigSecretRefs } from "./index.js";
import { HarnessConfigSchema } from "./schema.js";

describe("getConfigSecretRefs", () => {
  it("returns schema-owned references without interpreting arbitrary strings", () => {
    const config = HarnessConfigSchema.parse({
      models: {
        providers: [
          {
            id: "provider",
            kind: "openai",
            apiKey: "env:DOCTOR_TEST_API_KEY",
          },
        ],
      },
      roles: [
        {
          id: "role",
          tools: [],
          systemPrompt: "env:PRODUCTION",
        },
      ],
      servers: [
        {
          id: "stdio",
          transport: {
            kind: "stdio",
            command: "server",
            env: {
              API_TOKEN: "env:SERVER_TOKEN",
              PLAIN_VALUE: "an ordinary value",
            },
          },
        },
        {
          id: "http",
          transport: {
            kind: "http",
            url: "http://localhost:3000",
            headers: {
              Authorization: "file:/run/secrets/server-token",
            },
          },
        },
      ],
    });

    expect(getConfigSecretRefs(config)).toEqual([
      "env:DOCTOR_TEST_API_KEY",
      "env:SERVER_TOKEN",
      "file:/run/secrets/server-token",
    ]);
  });
});
