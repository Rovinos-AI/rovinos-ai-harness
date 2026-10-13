// SPDX-License-Identifier: Apache-2.0
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/client";
import { Code, Id } from "@harness/schemas";
import type { HostDiagnosticCode } from "./resource.js";
import type { UiSession, UiSessionContext } from "./ui-session.js";
import { z } from "zod";
import type {
  AppCallExecutionContext,
  AppCallRejectedReason,
} from "./app-calls.js";

/** Validated app-originated call payload accepted at the host boundary. */
export const AppCallSchema = z
  .object({
    appId: Code,
    sessionId: Id,
    runId: Id.optional(),
    callId: Id.optional(),
    approvalId: Id.optional(),
    approvalIds: z.array(Id).optional(),
    toolName: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

/** An MCP Apps tool call forwarded to the host's task 3.3 handler. */
export type AppCall = z.infer<typeof AppCallSchema>;

/** Injected boundary for reading resources from their originating MCP server. */
export type AppResourceReader = (resourceUri: string) => Promise<unknown>;

/** Minimal request contract shared by the server and its tests. */
export interface HostRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string;
  readonly url?: string;
  readonly headers: {
    readonly authorization?: string;
    readonly host?: string;
    readonly origin?: string;
    readonly "sec-fetch-site"?: string;
  };
}

/** Minimal HTTP response contract shared by the server and its tests. */
export interface HostResponse {
  readonly headersSent: boolean;
  writeHead(status: number, headers: Record<string, string>): void;
  write(value: string): boolean;
  end(value?: string | Buffer): void;
  destroy(error?: Error): void;
}

/** Minimal HTTP server contract shared by the server and its tests. */
export interface HttpServerPort {
  once(event: "error", listener: (error: Error) => void): this;
  listen(port: number, host: string, callback: () => void): this;
  address(): { readonly port: number } | string | null;
  close(callback: (error?: Error) => void): this;
}

/** Request callback contract used by the host HTTP server. */
export type RequestListener = (request: HostRequest, response: HostResponse) => Promise<void>;

/** One launched app instance and its process-local session identifier. */
export interface AppInstance {
  readonly id: string;
  readonly resourceUri: string;
  readonly sessionId: string;
  readonly runId?: Id;
  readonly uiSession?: UiSession;
  readonly end: () => void;
}

/** Dependencies that make process randomness, time, and app-call routing testable. */
export interface ReferenceHostDependencies {
  /** Reads a UI resource through the MCP client for the server that owns it. */
  readonly readResource: AppResourceReader;
  /** Creates deterministic session IDs in tests; production generates ULIDs. */
  readonly idGenerator?: () => string;
  /** Provides process entropy in tests; production uses operating-system cryptographic randomness. */
  readonly randomBytes?: (size: number) => Buffer;
  /** Provides epoch milliseconds for generated ULIDs. */
  readonly now?: () => number;
  /** Receives safe host diagnostic codes, never resource data or call payloads. */
  readonly onCode: (code: HostDiagnosticCode) => void;
  /** Routes allowlisted app calls through the host's policy-aware handler. */
  readonly onAppCall?: (
    call: AppCall,
    context: AppCallExecutionContext,
  ) => Promise<CallToolResult>;
  /** Handles app telemetry locally without forwarding it to an MCP server. */
  readonly onTelemetryEmit?: (
    session: AppInstance,
    args: { readonly spans: readonly unknown[] },
    context: AppCallExecutionContext,
  ) => Promise<CallToolResult>;
  /** Lists MCP tools for an app; the host router filters this result to its allowlist. */
  readonly onAppToolsList?: (
    appId: Code,
    allowedTools: readonly Code[],
    cursor?: string,
  ) => Promise<ListToolsResult>;
  /** Confirms that a call or approval identifier belongs to the active run. */
  readonly isIdOwnedByRun?: (runId: Id, id: Id) => boolean | Promise<boolean>;
  /** Counts a rejected app tool call using a bounded reason. */
  readonly onAppRejected?: (reason: AppCallRejectedReason) => void;
  /** Injectable static asset reader for tests. */
  readonly readStatic?: (asset: "index" | "bundle") => Promise<Buffer>;
  /** Injectable HTTP server factory for tests that must not use a network socket. */
  readonly createHttpServer?: (listener: RequestListener) => HttpServerPort;
  /** Input data delivered to the app after it initializes. */
  readonly toolInput?: Readonly<Record<string, unknown>>;
  /** Result data delivered to the app after it initializes. */
  readonly toolResult?: CallToolResult;
  /** Run and originating tool-call span for opt-in app trace propagation. */
  readonly uiSessionContext?: UiSessionContext;
  /** Run binding for host sessions when trace propagation is disabled. */
  readonly runId?: Id;
  /** Injectable UI-session expiry timer; returns a function that cancels it. */
  readonly scheduleUiSessionExpiry?: (callback: () => void, delayMs: number) => () => void;
}
