// SPDX-License-Identifier: Apache-2.0
// Reference host configuration is owned by task 3.1.
import { z } from "zod";
import { Code } from "../primitives.js";

const AppPermissionSchema = z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]);
const CspOriginSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.hostname.includes("*") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    context.addIssue({
      code: "custom",
      message: "CSP allowlist entries must be secure origins without credentials or paths.",
      params: { errorCode: "host_csp_origin_invalid" },
    });
  }
});

const AppConfigSchema = z
  .object({
    id: Code,
    resourceUri: z.string().startsWith("ui://"),
    telemetry: z.boolean().default(false),
    allowedTools: z.array(Code),
  })
  .strict()
  .superRefine((app, context) => {
    if (new Set(app.allowedTools).size !== app.allowedTools.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedTools"],
        message: "Allowed tools must be unique.",
        params: { errorCode: "host_allowed_tool_duplicate" },
      });
    }
  });

const ListenConfigSchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65_535).default(0),
  })
  .strict()
  .superRefine((listen, context) => {
    if (listen.host !== "127.0.0.1" && listen.host !== "::1" && listen.host !== "localhost") {
      context.addIssue({
        code: "custom",
        path: ["host"],
        message: "The reference host must listen on a loopback address.",
        params: { errorCode: "host_listen_not_loopback" },
      });
    }
  });

/** Validated MCP Apps reference-host configuration. */
export const HostConfigSchema = z
  .object({
    apps: z
      .array(AppConfigSchema)
      .default([])
      .superRefine((apps, context) => {
        const ids = new Set<string>();
        const resources = new Set<string>();
        for (const [index, app] of apps.entries()) {
          if (ids.has(app.id)) {
            context.addIssue({
              code: "custom",
              path: [index, "id"],
              message: "App IDs must be unique.",
              params: { errorCode: "host_app_id_duplicate" },
            });
          }
          if (resources.has(app.resourceUri)) {
            context.addIssue({
              code: "custom",
              path: [index, "resourceUri"],
              message: "App resource URIs must be unique.",
              params: { errorCode: "host_resource_uri_duplicate" },
            });
          }
          ids.add(app.id);
          resources.add(app.resourceUri);
        }
      }),
    listen: ListenConfigSchema.default({ host: "127.0.0.1", port: 0 }),
    maxUiSessions: z.number().int().positive().max(1024).default(32),
    permissionAllowlist: z.array(AppPermissionSchema).default([]),
    cspAllowlist: z.array(CspOriginSchema).default([]),
    uiSessionMaxMs: z.number().int().positive().default(3_600_000),
  })
  .strict();

/** Inferred reference-host configuration. */
export type HostConfig = z.infer<typeof HostConfigSchema>;
