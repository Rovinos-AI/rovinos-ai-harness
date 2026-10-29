// SPDX-License-Identifier: Apache-2.0
import type { AppSpan } from "@rovinos/schemas";

/** Mirrors `APP_TELEMETRY_TOOL_NAME` from `@rovinos/schemas`; do not import it here because the shim must remain dependency-free at runtime and under 4 KB gzipped. */
export const APP_TELEMETRY_TOOL_NAME = "harness.telemetry.emit";

/** Closed set of span names accepted by the host. */
export type AppSpanName = AppSpan["name"];

/** Checks whether a runtime span name was declared by the app manifest. */
export function isManifestSpanName(
  value: unknown,
  declared: ReadonlySet<AppSpanName>,
): value is AppSpanName {
  if (typeof value !== "string") {
    return false;
  }
  for (const name of declared) {
    if (name === value) {
      return true;
    }
  }
  return false;
}

type SchemaSpanAttrs<Name extends AppSpanName> = Omit<
  Extract<AppSpan, { name: Name }>,
  "name" | "startOffsetMs" | "durationMs"
>;

/** Attributes required for a particular app span, excluding host-generated timing fields. */
export type SpanAttrs<Name extends AppSpanName> = keyof SchemaSpanAttrs<Name> extends never
  ? Record<string, never>
  : SchemaSpanAttrs<Name>;

/** Minimal host bridge shape needed to emit app telemetry. */
export interface AppTelemetryBridge {
  callTool(
    name: typeof APP_TELEMETRY_TOOL_NAME,
    args: { readonly spans: readonly AppSpan[] },
  ): Promise<unknown>;
}

/** Manifest declarations statically constrain every span emitted by the shim. */
export interface AppTelemetryManifest<Names extends readonly AppSpanName[]> {
  readonly spans: Names;
}

/** Options for creating a manifest-scoped telemetry shim. */
export interface CreateAppTelemetryOptions<Names extends readonly AppSpanName[]> {
  readonly bridge?: AppTelemetryBridge;
  /** Resolves when the host bridge is connected; activation timeout starts afterward. */
  readonly hostReady?: Promise<void>;
  readonly manifest: AppTelemetryManifest<Names>;
  readonly now?: () => number;
  /** Injectable source for bounded retry jitter. */
  readonly random?: () => number;
}

/** Informational trace context returned by the host; never attached to app spans. */
export interface AppTraceContext {
  /** Host trace identifier, when the tool result contains a valid W3C traceparent. */
  readonly traceId: string | undefined;
}

/** Bounded transport counters exposed for local debugging only. */
export interface AppTelemetryStats {
  /** Number of spans dropped to enforce limits or abandoned during disposal. */
  readonly dropped: number;
}

/** Telemetry methods available to the app for its manifest-declared spans. */
export interface AppTelemetry<Names extends readonly AppSpanName[]> {
  /** Whether the host confirmed the telemetry tool is callable. */
  readonly active: boolean;
  /** Informational trace identifier supplied by the host. */
  readonly traceContext: AppTraceContext;
  /** Updates the informational trace context from host tool-result metadata. */
  setHostMetadata(metadata: unknown): void;
  /** Starts timing a declared span; ending it records its attributes and duration. */
  start<Name extends Names[number]>(
    name: Name,
  ): {
    end(attrs?: SpanAttrs<Name>): void;
  };
  /** Records a declared span whose duration has already been measured. */
  record<Name extends Names[number]>(
    name: Name,
    attrs: SpanAttrs<NoInfer<Name>>,
    durationMs?: number,
  ): void;
  /** Sends queued spans to the host; bridge failures are intentionally silent. */
  flush(): Promise<void>;
  /** Returns local-only transport counters. */
  stats(): AppTelemetryStats;
  /** Clears timers and listeners, drains pending spans, and counts any abandoned spans as dropped. */
  dispose(): Promise<void>;
}
