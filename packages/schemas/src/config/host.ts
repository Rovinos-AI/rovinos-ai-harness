// SPDX-License-Identifier: Apache-2.0
// Reference host configuration is owned by task 3.1.
import { z } from "zod";
import { Code } from "../primitives.js";

const AppPermissionSchema = z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]);

const AppConfigSchema = z
  .object({
    id: Code,
    resourceUri: z.string().startsWith("ui://"),
    telemetry: z.boolean(),
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
    permissionAllowlist: z.array(AppPermissionSchema).default([]),
    cspAllowlist: z.array(z.url()).default([]),
  })
  .strict();

/** Inferred reference-host configuration. */
export type HostConfig = z.infer<typeof HostConfigSchema>;
