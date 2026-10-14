// SPDX-License-Identifier: Apache-2.0
import type { AppSpan } from "@harness/schemas";

/** Closed set of span names accepted by the host. */
export type AppSpanName = AppSpan["name"];

/** Attributes required for a particular app span, excluding host-generated timing fields. */
export type SpanAttrs<Name extends AppSpanName> = Omit<
  Extract<AppSpan, { name: Name }>,
  "name" | "startOffsetMs" | "durationMs"
>;

/** Minimal host bridge shape needed to emit app telemetry. */
export interface AppTelemetryBridge {
  callTool(
    name: "harness.telemetry.emit",
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
  readonly manifest: AppTelemetryManifest<Names>;
  readonly now?: () => number;
}

/** Telemetry methods available to the app for its manifest-declared spans. */
export interface AppTelemetry<Names extends readonly AppSpanName[]> {
  /** Whether a callable host bridge was supplied. */
  readonly active: boolean;
  /** Starts timing a declared span; ending it records its attributes and duration. */
  start<Name extends Names[number]>(name: Name): {
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
}
