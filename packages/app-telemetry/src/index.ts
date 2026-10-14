// SPDX-License-Identifier: Apache-2.0
import type { AppSpan } from "@harness/schemas";
import type {
  AppSpanName,
  AppTelemetry,
  CreateAppTelemetryOptions,
} from "./types.js";
export type {
  AppSpanName,
  AppTelemetry,
  AppTelemetryBridge,
  AppTelemetryManifest,
  CreateAppTelemetryOptions,
  SpanAttrs,
} from "./types.js";

const maxDurationMs = 3_600_000;
const maxPendingSpans = 50;

type MutableAppSpan = AppSpan;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function makeSpan(
  name: AppSpanName,
  attrs: unknown,
  startOffsetMs: number,
  durationMs: number,
): MutableAppSpan | undefined {
  if (!isRecord(attrs)) {
    return undefined;
  }
  switch (name) {
    case "ui.render":
      return hasOnlyKeys(attrs, [])
        ? { name, startOffsetMs, durationMs }
        : undefined;
    case "ui.decision":
      return hasOnlyKeys(attrs, ["decision"]) &&
        (attrs.decision === "approve" || attrs.decision === "deny" || attrs.decision === "edit")
        ? { name, decision: attrs.decision, startOffsetMs, durationMs }
        : undefined;
    case "ui.error":
      return hasOnlyKeys(attrs, ["code"]) &&
        typeof attrs.code === "string" &&
        /^[a-z0-9_.-]{1,64}$/u.test(attrs.code)
        ? { name, code: attrs.code, startOffsetMs, durationMs }
        : undefined;
    case "ui.interaction":
      return hasOnlyKeys(attrs, ["kind", "count"]) &&
        (attrs.kind === "click" || attrs.kind === "focus" || attrs.kind === "edit") &&
        typeof attrs.count === "number" &&
        Number.isInteger(attrs.count) &&
        attrs.count >= 0 &&
        attrs.count <= 1000
        ? { name, kind: attrs.kind, count: attrs.count, startOffsetMs, durationMs }
        : undefined;
  }
}

function roundedDuration(durationMs: number): number | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > maxDurationMs) {
    return undefined;
  }
  return Math.round(durationMs);
}

/**
 * Creates a browser-safe shim that only queues manifest-declared spans for its host bridge.
 *
 * @param options - Host bridge, allowed span names, and optional monotonic clock.
 * @returns A no-throw telemetry interface scoped to the supplied manifest.
 */
export function createAppTelemetry<const Names extends readonly AppSpanName[]>(
  options: CreateAppTelemetryOptions<Names>,
): AppTelemetry<Names> {
  const pending: MutableAppSpan[] = [];
  const declared = new Set<AppSpanName>();
  try {
    for (const name of options.manifest.spans) {
      declared.add(name);
    }
  } catch {
    declared.clear();
  }

  let bridgeIsActive = false;
  let bridge = options.bridge;
  try {
    bridgeIsActive = typeof bridge?.callTool === "function";
  } catch {
    bridgeIsActive = false;
    bridge = undefined;
  }

  const now = options.now ?? (() => performance.now());
  let createdAt: number | undefined;
  try {
    const initialTime = now();
    createdAt = Number.isFinite(initialTime) ? initialTime : undefined;
  } catch {
    createdAt = undefined;
  }

  function recordSpan(
    name: AppSpanName,
    attrs: unknown,
    durationMs: number,
    startedAt?: number,
  ): void {
    if (!bridgeIsActive || !declared.has(name) || pending.length >= maxPendingSpans) {
      return;
    }
    try {
      const duration = roundedDuration(durationMs);
      const currentTime = startedAt ?? now();
      if (duration === undefined || createdAt === undefined || !Number.isFinite(currentTime)) {
        return;
      }
      const startOffsetMs = Math.round(currentTime - createdAt);
      if (startOffsetMs < 0) {
        return;
      }
      const span = makeSpan(name, attrs, startOffsetMs, duration);
      if (span !== undefined) {
        pending.push(span);
      }
    } catch {
      return;
    }
  }

  return {
    active: bridgeIsActive,
    start<Name extends Names[number]>(name: Name) {
      if (!bridgeIsActive || !declared.has(name) || createdAt === undefined) {
        return { end: () => undefined };
      }
      let startedAt: number | undefined;
      try {
        const currentTime = now();
        startedAt = Number.isFinite(currentTime) ? currentTime : undefined;
      } catch {
        startedAt = undefined;
      }
      return {
        end(attrs?: Parameters<typeof recordSpan>[1]) {
          if (startedAt === undefined || (attrs === undefined && name !== "ui.render")) {
            return;
          }
          try {
            const currentTime = now();
            if (!Number.isFinite(currentTime)) {
              return;
            }
            recordSpan(name, attrs ?? {}, currentTime - startedAt, startedAt);
          } catch {
            return;
          }
        },
      };
    },
    record<Name extends Names[number]>(name: Name, attrs: Parameters<typeof recordSpan>[1], durationMs = 0) {
      recordSpan(name, attrs, durationMs);
    },
    async flush() {
      if (!bridgeIsActive || bridge === undefined || pending.length === 0) {
        return;
      }
      const batch = pending.slice();
      try {
        await bridge.callTool("harness.telemetry.emit", { spans: batch });
        pending.splice(0, batch.length);
      } catch {
        return;
      }
    },
  };
}
