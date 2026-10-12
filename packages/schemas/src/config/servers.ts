// SPDX-License-Identifier: Apache-2.0
// MCP server configuration is owned by task 6.1.
import { z } from "zod";
import { Code } from "../primitives.js";
import { SecretRefSchema } from "../secret-ref.js";
import { isSecretKeyName } from "../secret-key-name.js";

const ServerTimeoutsSchema = z
  .object({
    connectMs: z.number().int().positive().default(10_000),
    callMs: z.number().int().positive().default(60_000),
  })
  .strict()
  .prefault({});

const ToolNamesSchema = z
  .array(z.string().min(1))
  .superRefine((names, context) => {
    const seen = new Set<string>();
    for (const [index, name] of names.entries()) {
      if (seen.has(name)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Tool names must be unique within a list.",
          params: { errorCode: "server_tool_name_duplicate" },
        });
      }
      seen.add(name);
    }
  });

const StdioTransportSchema = z
  .object({
    kind: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.union([z.string(), SecretRefSchema])).optional(),
    cwd: z.string().min(1).optional(),
    inheritEnv: z.boolean().default(false),
  })
  .strict()
  .superRefine((transport, context) => {
    for (const [key, value] of Object.entries(transport.env ?? {})) {
      if (isSecretKeyName(key) && !SecretRefSchema.safeParse(value).success) {
        context.addIssue({
          code: "custom",
          path: ["env", key],
          message: "Secret-looking environment values must be SecretRef values.",
          params: { errorCode: "secret_inline" },
        });
      }
    }
  });

const HttpTransportSchema = z
  .object({
    kind: z.literal("http"),
    url: z.url().superRefine((url, context) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return;
      }
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname);
      if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
        context.addIssue({
          code: "custom",
          message: "HTTP server URLs must not contain credentials.",
          params: { errorCode: "server_url_credentials" },
        });
      }
      if (
        (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
        (parsedUrl.protocol !== "https:" && !isLoopback)
      ) {
        context.addIssue({
          code: "custom",
          message: "HTTP server URLs must use HTTPS unless the host is loopback.",
          params: { errorCode: "server_http_url_untrusted" },
        });
      }
    }),
    headers: z.record(z.string(), SecretRefSchema).optional(),
  })
  .strict();

const ServerConfigObjectSchema = z
  .object({
    id: Code,
    transport: z.discriminatedUnion("kind", [StdioTransportSchema, HttpTransportSchema]),
    protocol: z.enum(["auto", "2026-07-28", "2025-11-25"]).default("auto"),
    apps: z.boolean().default(false),
    trust: z.enum(["internal", "external"]).default("external"),
    propagateTrace: z.boolean().default(false),
    toolAllowlist: ToolNamesSchema.optional(),
    toolPrefix: Code.optional(),
    idempotentTools: ToolNamesSchema.optional(),
    useAnnotations: z.boolean().default(false),
    timeouts: ServerTimeoutsSchema,
    maxResultBytes: z.number().int().positive().default(1_048_576),
  })
  .strict();

/** MCP server connection, trust, and tool-registration configuration. */
export const ServerConfigSchema = ServerConfigObjectSchema.superRefine((server, context) => {
  if (server.propagateTrace && server.trust !== "internal") {
    context.addIssue({
      code: "custom",
      path: ["propagateTrace"],
      message: "Trace propagation requires an internal server.",
      params: { errorCode: "propagate_requires_internal" },
    });
  }
  if (server.useAnnotations && server.trust !== "internal") {
    context.addIssue({
      code: "custom",
      path: ["useAnnotations"],
      message: "Annotations require an internal server.",
      params: { errorCode: "annotations_require_internal" },
    });
  }
  if (server.toolAllowlist !== undefined) {
    for (const [index, toolName] of (server.idempotentTools ?? []).entries()) {
      if (!server.toolAllowlist.includes(toolName)) {
        context.addIssue({
          code: "custom",
          path: ["idempotentTools", index],
          message: "Idempotent tools must be included in the tool allowlist.",
          params: { errorCode: "server_idempotent_not_allowed" },
        });
      }
    }
  }
}).transform(({ toolPrefix, ...server }) => ({
  ...server,
  toolPrefix: toolPrefix ?? server.id,
}));

/** A list of MCP server configurations with unique server IDs. */
export const ServersConfigSchema = z
  .array(ServerConfigSchema)
  .default([])
  .superRefine((servers, context) => {
    const ids = new Set<string>();
    const toolPrefixes = new Set<string>();
    for (const [index, server] of servers.entries()) {
      if (ids.has(server.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Server IDs must be unique.",
          params: { errorCode: "server_id_duplicate" },
        });
      }
      ids.add(server.id);
      if (toolPrefixes.has(server.toolPrefix)) {
        context.addIssue({
          code: "custom",
          path: [index, "toolPrefix"],
          message: "Tool prefixes must be unique across servers.",
          params: { errorCode: "server_tool_prefix_duplicate" },
        });
      }
      toolPrefixes.add(server.toolPrefix);
    }
  });

/** Inferred configuration for a single MCP server. */
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
/** Inferred list of MCP server configurations. */
export type ServersConfig = z.infer<typeof ServersConfigSchema>;
