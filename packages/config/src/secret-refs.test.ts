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
            auth: {
              kind: "oauth",
              grant: "client_credentials",
              clientSecret: "file:/run/secrets/oauth-client-secret",
            },
          },
        },
      ],
      keys: {
        currentKeyId: "primary",
        keys: [
          { id: "primary", secret: "env:DOCTOR_PRIMARY_KEY" },
          { id: "previous", secret: "file:/run/secrets/doctor-previous-key" },
        ],
      },
      store: {
        dialect: "postgres",
        connectionString: "env:DOCTOR_STORE_URL",
      },
      vault: {
        backend: "postgres",
        postgres: { url: "env:DOCTOR_VAULT_URL" },
      },
      sandbox: {
        runner: { url: "http://sandbox-runner:8080", token: "env:SANDBOX_RUNNER_TOKEN" },
      },
      policy: {
        approvals: {
          notifier: {
            kind: "webhook",
            url: "https://hooks.example.test/approval",
            secretRef: "env:APPROVAL_WEBHOOK_TOKEN",
          },
        },
      },
      controlPlane: {
        auth: {
          tokens: [
            {
              id: "token.viewer",
              secret: "env:CONTROL_PLANE_TOKEN",
              scopes: ["read"],
            },
          ],
        },
        tls: {
          certFile: "file:/run/secrets/control-plane-cert",
          keyFile: "file:/run/secrets/control-plane-key",
        },
      },
    });

    expect(getConfigSecretRefs(config)).toEqual([
      "env:DOCTOR_TEST_API_KEY",
      "env:SERVER_TOKEN",
      "file:/run/secrets/server-token",
      "file:/run/secrets/oauth-client-secret",
      "env:DOCTOR_PRIMARY_KEY",
      "file:/run/secrets/doctor-previous-key",
      "env:DOCTOR_STORE_URL",
      "env:DOCTOR_VAULT_URL",
      "env:SANDBOX_RUNNER_TOKEN",
      "env:APPROVAL_WEBHOOK_TOKEN",
      "env:CONTROL_PLANE_TOKEN",
      "file:/run/secrets/control-plane-cert",
      "file:/run/secrets/control-plane-key",
    ]);
  });
});
