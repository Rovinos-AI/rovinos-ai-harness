// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { Code, HostConfigSchema, Id } from "@rovinos/schemas";
import type { HostAppRejectedReason } from "@rovinos/telemetry";
import {
  AppRequestRouter,
  AppRequestSchema,
  type AppRequestRouterOptions,
} from "./app-requests.js";
import type { AppInstance } from "./types.js";

const runId = Id.parse("00000000000000000000000001");
const sessionId = Id.parse("00000000000000000000000002");
const appId = Code.parse("test-app");
const resourceUri = "ui://test/app";

function createSession(overrides: Partial<AppInstance> = {}): AppInstance {
  return {
    id: appId,
    resourceUri,
    sessionId,
    runId,
    end: () => undefined,
    ...overrides,
  };
}

function createRouter(
  allow: { openLink: boolean; message: boolean; modelContext: boolean } = {
    openLink: false,
    message: false,
    modelContext: false,
  },
  options: Partial<AppRequestRouterOptions> = {},
): { readonly router: AppRequestRouter; readonly rejected: HostAppRejectedReason[] } {
  const rejected: HostAppRejectedReason[] = [];
  const app = HostConfigSchema.parse({
    apps: [{ id: appId, resourceUri, allowedTools: [], allow }],
  }).apps[0];
  if (app === undefined) {
    throw new Error("Test app configuration is missing.");
  }
  return {
    router: new AppRequestRouter({
      apps: new Map([[appId, app]]),
      onRejected: (reason) => rejected.push(reason),
      ...options,
    }),
    rejected,
  };
}

describe("AppRequestSchema", () => {
  it("accepts only known request shapes and requires content", () => {
    expect(
      AppRequestSchema.safeParse({ kind: "open_link", sessionId, url: "https://example.test" })
        .success,
    ).toBe(true);
    expect(
      AppRequestSchema.safeParse({ kind: "open_link", sessionId, consented: false }).success,
    ).toBe(true);
    expect(
      AppRequestSchema.safeParse({ kind: "open_link", sessionId, consented: true }).success,
    ).toBe(false);
    expect(AppRequestSchema.safeParse({ kind: "message", sessionId, content: [] }).success).toBe(
      false,
    );
    expect(AppRequestSchema.safeParse({ kind: "model_context", sessionId }).success).toBe(false);
    expect(
      AppRequestSchema.safeParse({
        kind: "message",
        sessionId,
        content: [{ type: "text", text: "hello" }],
        unexpected: "value",
      }).success,
    ).toBe(false);
    expect(
      AppRequestSchema.safeParse({
        kind: "message",
        sessionId,
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      }).success,
    ).toBe(false);
  });
});

describe("AppRequestRouter", () => {
  it("denies external links by default and counts the bounded reason", async () => {
    const { router, rejected } = createRouter();
    await expect(
      router.handle(
        createSession(),
        AppRequestSchema.parse({ kind: "open_link", sessionId, url: "https://example.test" }),
      ),
    ).resolves.toEqual({ allowed: false });
    expect(rejected).toEqual(["request_disabled"]);
  });

  it("allows only safe HTTP(S) links after app opt-in and counts user denial", async () => {
    const { router, rejected } = createRouter({
      openLink: true,
      message: false,
      modelContext: false,
    });
    await expect(
      router.handle(
        createSession(),
        AppRequestSchema.parse({ kind: "open_link", sessionId, url: "https://example.test/path" }),
      ),
    ).resolves.toEqual({ allowed: true });
    await expect(
      router.handle(
        createSession(),
        AppRequestSchema.parse({ kind: "open_link", sessionId, url: "javascript:alert(1)" }),
      ),
    ).resolves.toEqual({ allowed: false });
    await expect(
      router.handle(
        createSession(),
        AppRequestSchema.parse({ kind: "open_link", sessionId, url: "******example.test" }),
      ),
    ).resolves.toEqual({ allowed: false });
    await expect(
      router.handle(
        createSession(),
        AppRequestSchema.parse({ kind: "open_link", sessionId, consented: false }),
      ),
    ).resolves.toEqual({ allowed: false });
    expect(rejected).toEqual(["request_invalid", "request_invalid", "user_denied"]);
  });

  it("tokenizes message content at model_input and labels it as app-provided", async () => {
    const recorded: unknown[] = [];
    const { router, rejected } = createRouter(
      { openLink: false, message: true, modelContext: false },
      {
        tokenizeAppContent: vi.fn((_run, content, context) => {
          expect(context).toEqual({ boundary: "model_input" });
          expect(content).toEqual({ content: [{ type: "text", text: "alice@example.test" }] });
          return Promise.resolve({ content: [{ type: "text", text: "<EMAIL_1>" }] });
        }),
        onAppContent: (value) => {
          recorded.push(value);
          return Promise.resolve();
        },
      },
    );
    await expect(
      router.handle(
        createSession(),
        AppRequestSchema.parse({
          kind: "message",
          sessionId,
          content: [{ type: "text", text: "alice@example.test" }],
        }),
      ),
    ).resolves.toEqual({ allowed: true });
    expect(recorded).toEqual([
      {
        kind: "message",
        source: "app",
        label: "App-provided",
        appId,
        runId,
        content: { content: [{ type: "text", text: "<EMAIL_1>" }] },
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("alice@example.test");
    expect(rejected).toEqual([]);
  });

  it("denies messages by default and model context is separately gated and tokenized", async () => {
    const denied = createRouter();
    await expect(
      denied.router.handle(
        createSession(),
        AppRequestSchema.parse({
          kind: "message",
          sessionId,
          content: [{ type: "text", text: "untrusted" }],
        }),
      ),
    ).resolves.toEqual({ allowed: false });
    expect(denied.rejected).toEqual(["request_disabled"]);

    const recorded: unknown[] = [];
    const { router } = createRouter(
      { openLink: false, message: false, modelContext: true },
      {
        tokenizeAppContent: (_run, content) => Promise.resolve(content),
        onAppContent: (value) => {
          recorded.push(value);
          return Promise.resolve();
        },
      },
    );
    await expect(
      router.handle(
        createSession(),
        AppRequestSchema.parse({
          kind: "model_context",
          sessionId,
          content: [{ type: "text", text: "context" }],
          structuredContent: { detail: "value" },
        }),
      ),
    ).resolves.toEqual({ allowed: true });
    expect(recorded).toMatchObject([
      {
        kind: "model_context",
        source: "app",
        label: "App-provided",
        content: {
          content: [{ type: "text", text: "context" }],
          structuredContent: { detail: "value" },
        },
      },
    ]);
  });

  it("fails closed when the run, tokenizer, or recorder is unavailable or throws", async () => {
    const noRun = createRouter(
      { openLink: false, message: true, modelContext: false },
      {
        tokenizeAppContent: (_run, content) => Promise.resolve(content),
        onAppContent: () => Promise.resolve(),
      },
    );
    const request = AppRequestSchema.parse({
      kind: "message",
      sessionId,
      content: [{ type: "text", text: "synthetic" }],
    });
    const sessionWithoutRun: AppInstance = {
      id: appId,
      resourceUri,
      sessionId,
      end: () => undefined,
    };
    await expect(noRun.router.handle(sessionWithoutRun, request)).resolves.toEqual({
      allowed: false,
    });
    const missing = createRouter({ openLink: false, message: true, modelContext: false });
    await expect(missing.router.handle(createSession(), request)).resolves.toEqual({
      allowed: false,
    });
    const throwing = createRouter(
      { openLink: false, message: true, modelContext: false },
      {
        tokenizeAppContent: () => Promise.reject(new Error("raw canary must not escape")),
        onAppContent: () => Promise.resolve(),
      },
    );
    await expect(throwing.router.handle(createSession(), request)).resolves.toEqual({
      allowed: false,
    });
    expect(noRun.rejected).toEqual(["request_unavailable"]);
    expect(missing.rejected).toEqual(["request_unavailable"]);
    expect(throwing.rejected).toEqual(["request_unavailable"]);
  });

  it("rejects mismatched sessions and isolates rejection observer failures", async () => {
    const { router, rejected } = createRouter(
      { openLink: true, message: false, modelContext: false },
      {
        onRejected: () => {
          throw new Error("observer failure");
        },
      },
    );
    await expect(
      router.handle(
        createSession({ sessionId: Id.parse("00000000000000000000000003") }),
        AppRequestSchema.parse({ kind: "open_link", sessionId, url: "https://example.test" }),
      ),
    ).resolves.toEqual({ allowed: false });
    expect(rejected).toEqual([]);
  });
});
