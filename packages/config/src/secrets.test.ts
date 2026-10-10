// SPDX-License-Identifier: Apache-2.0
import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecretRefSchema } from "@harness/schemas";
import { ConfigError, loadConfig } from "./index.js";
import {
  CompositeSecretResolver,
  EnvSecretResolver,
  FileSecretResolver,
  Secret,
} from "./secrets.js";

const validConfig = JSON.stringify({
  run: { budgets: { maxSteps: 12 } },
  store: {},
  models: {},
  servers: [],
  policy: {},
  pii: {},
  telemetry: {},
  sandbox: {},
});

function configWith(additions: Record<string, unknown>): string {
  return JSON.stringify({
    run: { budgets: { maxSteps: 12 } },
    store: {},
    models: {},
    servers: [],
    policy: {},
    pii: {},
    telemetry: {},
    sandbox: {},
    ...additions,
  });
}

function requireConfigError(error: unknown): ConfigError {
  if (error instanceof ConfigError) {
    return error;
  }
  throw new Error("Expected ConfigError.");
}

describe("SecretRefSchema", () => {
  it.each(["env:API_KEY", "file:/run/secrets/model-key", "akv:vault-name/secret-name"])(
    "accepts %s references",
    (ref) => {
      expect(SecretRefSchema.parse(ref)).toBe(ref);
    },
  );

  it.each(["", "http:value", "env:", "env:1INVALID", "file:relative/path", "akv:vault/"])(
    "rejects invalid reference %s with a safe code",
    (ref) => {
      const result = SecretRefSchema.safeParse(ref);
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);

      expect(result).toMatchObject({
        success: false,
      });
      expect(messages).toContain("secret_ref_invalid");
    },
  );
});

describe("Secret", () => {
  it("reveals only explicitly and redacts string, JSON, inspect, and log formatting", () => {
    const secret = new Secret("private-secret-value");

    expect(secret.reveal()).toBe("private-secret-value");
    expect(String(secret)).toBe("[REDACTED]");
    expect(JSON.stringify(secret)).toBe('"[REDACTED]"');
    expect(inspect(secret)).toBe("[REDACTED]");
    expect(format("credential=%s", secret)).toBe("credential=[REDACTED]");
    expect(format("credential=%o", secret)).toBe("credential=[REDACTED]");
  });
});

describe("EnvSecretResolver", () => {
  it("resolves a present variable", async () => {
    const secret = await new EnvSecretResolver({ API_KEY: "private-value" }).resolve(
      SecretRefSchema.parse("env:API_KEY"),
    );

    expect(secret.reveal()).toBe("private-value");
  });

  it("returns secret_not_found for a missing variable without echoing the name or value", async () => {
    await expect(
      new EnvSecretResolver({}).resolve(SecretRefSchema.parse("env:MISSING_KEY")),
    ).rejects.toMatchObject({ code: "secret_not_found", message: "secret_not_found" });
  });

  it("rejects a reference for another resolver", async () => {
    await expect(
      new EnvSecretResolver({}).resolve(SecretRefSchema.parse("file:/secret")),
    ).rejects.toMatchObject({ code: "secret_resolver_unavailable" });
  });
});

describe("FileSecretResolver", () => {
  it("trims one trailing LF or CRLF and continues after a permission warning", async () => {
    const warnings: string[] = [];
    const resolver = new FileSecretResolver({
      platform: "linux",
      stat: () => Promise.resolve({ mode: 0o100644 }),
      readFile: () => Promise.resolve("private-file-value\n\n"),
      onWarning: (code) => warnings.push(code),
    });
    const secret = await resolver.resolve(SecretRefSchema.parse("file:/run/secrets/key"));

    expect(secret.reveal()).toBe("private-file-value\n");
    expect(warnings).toEqual(["secret_file_permissions"]);
  });

  it("does not warn for private files or on Windows", async () => {
    const warnings: string[] = [];
    const resolver = new FileSecretResolver({
      platform: "win32",
      stat: () => Promise.resolve({ mode: 0o100644 }),
      readFile: () => Promise.resolve("private-value\r\n"),
      onWarning: (code) => warnings.push(code),
    });
    const secret = await resolver.resolve(SecretRefSchema.parse("file:/run/secrets/key"));

    expect(secret.reveal()).toBe("private-value");
    expect(warnings).toEqual([]);
  });

  it("returns secret_not_found when the file is missing", async () => {
    const resolver = new FileSecretResolver({
      stat: () => Promise.reject(Object.assign(new Error("private path"), { code: "ENOENT" })),
    });

    await expect(
      resolver.resolve(SecretRefSchema.parse("file:/missing/secret")),
    ).rejects.toMatchObject({ code: "secret_not_found" });
  });

  it("returns a sanitized unavailable code for other file errors", async () => {
    const resolver = new FileSecretResolver({
      stat: () => Promise.resolve({ mode: 0o100600 }),
      readFile: () => Promise.reject(Object.assign(new Error("private path"), { code: "EACCES" })),
    });

    await expect(
      resolver.resolve(SecretRefSchema.parse("file:/restricted/secret")),
    ).rejects.toMatchObject({ code: "secret_resolver_unavailable" });
  });

  it("rejects references for another resolver", async () => {
    await expect(
      new FileSecretResolver().resolve(SecretRefSchema.parse("env:API_KEY")),
    ).rejects.toMatchObject({ code: "secret_resolver_unavailable" });
  });
});

describe("CompositeSecretResolver", () => {
  it("dispatches env and file references and rejects unavailable Key Vault resolution", async () => {
    const resolver = new CompositeSecretResolver({
      env: new EnvSecretResolver({ API_KEY: "environment-secret" }),
      file: new FileSecretResolver({
        stat: () => Promise.resolve({ mode: 0o100600 }),
        readFile: () => Promise.resolve("file-secret"),
      }),
    });

    expect((await resolver.resolve(SecretRefSchema.parse("env:API_KEY"))).reveal()).toBe(
      "environment-secret",
    );
    expect((await resolver.resolve(SecretRefSchema.parse("file:/run/secrets/key"))).reveal()).toBe(
      "file-secret",
    );
    await expect(
      resolver.resolve(SecretRefSchema.parse("akv:vault-name/secret-name")),
    ).rejects.toMatchObject({ code: "secret_resolver_unavailable" });
  });
});

describe("inline config secrets", () => {
  it.each([
    {
      name: "apiKey",
      additions: { apiKey: "sk-live-x" },
      path: "apiKey",
      value: "sk-live-x",
      inline: true,
    },
    {
      name: "password",
      additions: { password: "hunter2" },
      path: "password",
      value: "hunter2",
      inline: true,
    },
    {
      name: "nested auth token secret",
      additions: { auth: { tokens: [{ secret: "plain" }] } },
      path: "auth.tokens.0.secret",
      value: "plain",
      inline: true,
    },
    {
      name: "maxOutputTokens",
      additions: { models: { maxOutputTokens: 4096 } },
      value: "4096",
      inline: false,
    },
    {
      name: "tokenizer",
      additions: { policy: { tokenizer: "cl100k_base" } },
      value: "cl100k_base",
      inline: false,
    },
    {
      name: "auth token reference",
      additions: { auth: { tokens: [{ secret: "env:X" }] } },
      value: "env:X",
      inline: false,
    },
  ])(
    "classifies $name without echoing submitted values",
    async ({ additions, path, value, inline }) => {
      const error = requireConfigError(
        await loadConfig({
          env: {},
          readFile: () => Promise.resolve(configWith(additions)),
        }).catch((caught: unknown) => caught),
      );

      expect(error.issues.some((issue) => issue.includes("secret_inline"))).toBe(inline);
      if (inline && path !== undefined) {
        expect(error.issues).toContain(`${path}: a SecretRef (secret_inline)`);
      }
      expect(error.message).not.toContain(value);
    },
  );

  it("rejects nested and array inline values without echoing any submitted secret", async () => {
    const inlineValues = ["apiKeyValue-secret", "bearerToken-secret", "databasePassword-secret"];
    const contents = JSON.stringify({
      run: { budgets: { maxSteps: 12 } },
      store: {},
      models: {
        apiKey: inlineValues[0],
        nested: { access_token: inlineValues[1] },
        credential: inlineValues[2],
      },
      servers: [{ clientSecret: "server-secret" }],
      policy: {},
      pii: {},
      telemetry: {},
      sandbox: {},
    });

    let error: unknown;
    try {
      await loadConfig({ env: {}, readFile: () => Promise.resolve(contents) });
    } catch (caught) {
      error = caught;
    }

    const configError = requireConfigError(error);
    expect(configError.issues).toContain("models.apiKey: a SecretRef (secret_inline)");
    expect(configError.issues).toContain("models.nested.access_token: a SecretRef (secret_inline)");
    expect(configError.issues).toContain("servers.0.clientSecret: a SecretRef (secret_inline)");
    expect(configError.message).not.toContain(inlineValues.join(""));
    for (const value of inlineValues) {
      expect(configError.message).not.toContain(value);
    }
  });

  it("does not classify a valid reference as an inline secret", async () => {
    const contents = validConfig.replace('"models":{}', '"models":{"apiKey":"env:API_KEY"}');
    let error: unknown;
    try {
      await loadConfig({ env: {}, readFile: () => Promise.resolve(contents) });
    } catch (caught) {
      error = caught;
    }

    const configError = requireConfigError(error);
    expect(configError.issues.some((issue) => issue.includes("secret_inline"))).toBe(false);
  });
});
