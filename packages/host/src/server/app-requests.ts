// SPDX-License-Identifier: Apache-2.0
import { ContentBlockSchema } from "@modelcontextprotocol/core";
import { Code, Id, JsonValue, type HostConfig } from "@harness/schemas";
import { countHostAppRejected, type HostAppRejectedReason } from "@harness/telemetry";
import { AppRequestResultSchema } from "../shared/app-request.js";
import { z } from "zod";
import type { AppInstance } from "./types.js";

const OpenLinkRequestSchema = z
  .object({
    kind: z.literal("open_link"),
    sessionId: Id,
    url: z.string().max(2048).optional(),
    consented: z.literal(false).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.consented === undefined && request.url === undefined) {
      context.addIssue({ code: "custom", path: ["url"], message: "URL is required." });
    }
  });

const AppMessageRequestSchema = z
  .object({
    kind: z.literal("message"),
    sessionId: Id,
    content: z.array(ContentBlockSchema).min(1).max(100),
  })
  .strict();

const ModelContextRequestSchema = z
  .object({
    kind: z.literal("model_context"),
    sessionId: Id,
    content: z.array(ContentBlockSchema).max(100).optional(),
    structuredContent: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.content === undefined && request.structuredContent === undefined) {
      context.addIssue({ code: "custom", message: "Model context is required." });
    }
  });

/** Parsed app-to-host requests accepted by the reference host. */
export const AppRequestSchema = z.discriminatedUnion("kind", [
  OpenLinkRequestSchema,
  AppMessageRequestSchema,
  ModelContextRequestSchema,
]);

/** Validated app request payload. */
export type AppRequest = z.infer<typeof AppRequestSchema>;

/** Sanitized app content recorded by the embedding run after PII tokenization. */
export const AppContentEnvelopeSchema = z
  .object({
    kind: z.enum(["message", "model_context"]),
    source: z.literal("app"),
    label: z.literal("App-provided"),
    appId: Code,
    runId: Id,
    content: JsonValue,
  })
  .strict();

/** Inferred tokenized content envelope with host-bound app identity. */
export type AppContentEnvelope = z.infer<typeof AppContentEnvelopeSchema>;

/** Tokenizes JSON content for the model-input boundary. */
export type AppContentTokenizer = (
  runId: Id,
  content: z.infer<typeof JsonValue>,
  context: { readonly boundary: "model_input" },
) => Promise<z.infer<typeof JsonValue>>;

/** Dependencies for request gates; absent content handlers fail closed. */
export interface AppRequestRouterOptions {
  readonly apps: ReadonlyMap<string, HostConfig["apps"][number]>;
  readonly tokenizeAppContent?: AppContentTokenizer;
  readonly onAppContent?: (content: AppContentEnvelope) => Promise<void>;
  readonly onRejected?: (reason: HostAppRejectedReason) => void;
}

/** Minimal response returned to the app bridge. */
export { AppRequestResultSchema };
/** Inferred minimal request result. */
export type AppRequestResult = z.infer<typeof AppRequestResultSchema>;

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

/**
 * Applies per-app capability checks, PII tokenization, and app-content labeling.
 */
export class AppRequestRouter {
  readonly #options: AppRequestRouterOptions;

  /** Binds request gates to validated app configuration and content adapters. */
  constructor(options: AppRequestRouterOptions) {
    this.#options = options;
  }

  /**
   * Handles one app request without retaining or logging its payload.
   *
   * @param session - Host-owned app session.
   * @param request - Schema-validated request from the SDK bridge.
   * @returns Whether the host accepted the request.
   */
  async handle(session: AppInstance, request: AppRequest): Promise<AppRequestResult> {
    const app = this.#options.apps.get(session.id);
    if (app === undefined || session.sessionId !== request.sessionId) {
      this.reject("unknown_app");
      return { allowed: false };
    }

    if (request.kind === "open_link") {
      return this.#handleOpenLink(app, request);
    }

    return this.#handleModelContent(session, app, request);
  }

  #handleOpenLink(
    app: HostConfig["apps"][number],
    request: Extract<AppRequest, { readonly kind: "open_link" }>,
  ): AppRequestResult {
    if (!app.allow.openLink) {
      this.reject("request_disabled");
      return { allowed: false };
    }
    if (request.consented === false) {
      this.reject("user_denied");
      return { allowed: false };
    }
    if (request.url === undefined || !isSafeExternalUrl(request.url)) {
      this.reject("request_invalid");
      return { allowed: false };
    }
    return { allowed: true };
  }

  async #handleModelContent(
    session: AppInstance,
    app: HostConfig["apps"][number],
    request: Exclude<AppRequest, { readonly kind: "open_link" }>,
  ): Promise<AppRequestResult> {
    const capability = request.kind === "message" ? "message" : "modelContext";
    if (!app.allow[capability]) {
      this.reject("request_disabled");
      return { allowed: false };
    }
    if (
      session.runId === undefined ||
      this.#options.tokenizeAppContent === undefined ||
      this.#options.onAppContent === undefined
    ) {
      this.reject("request_unavailable");
      return { allowed: false };
    }

    try {
      const content =
        request.kind === "message"
          ? { content: request.content }
          : {
              ...(request.content === undefined ? {} : { content: request.content }),
              ...(request.structuredContent === undefined
                ? {}
                : { structuredContent: request.structuredContent }),
            };
      const tokenized = await this.#options.tokenizeAppContent(session.runId, JsonValue.parse(content), {
        boundary: "model_input",
      });
      await this.#options.onAppContent(
        AppContentEnvelopeSchema.parse({
          kind: request.kind,
          source: "app",
          label: "App-provided",
          appId: app.id,
          runId: session.runId,
          content: JsonValue.parse(tokenized),
        }),
      );
      return { allowed: true };
    } catch {
      this.reject("request_unavailable");
      return { allowed: false };
    }
  }

  /** Counts a rejection using one of the host's bounded reason values. */
  reject(reason: HostAppRejectedReason): void {
    countHostAppRejected(reason);
    try {
      this.#options.onRejected?.(reason);
    } catch {
      return;
    }
  }
}
