// SPDX-License-Identifier: Apache-2.0
import type { AppSpan } from "@harness/schemas";
import { isManifestSpanName } from "./types.js";
import type {
  AppSpanName,
  AppTelemetry,
  AppTelemetryBridge,
  CreateAppTelemetryOptions,
  SpanAttrs,
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

interface RecorderContext {
  readonly active: boolean;
  readonly createdAt: number | undefined;
  readonly declared: ReadonlySet<AppSpanName>;
  readonly now: () => number;
  readonly pending: MutableAppSpan[];
}

interface RecordAppSpanInput {
  readonly name: AppSpanName;
  readonly attrs: unknown;
  readonly durationMs: number;
  readonly startedAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function makeRenderSpan(
  attrs: Record<string, unknown>,
  startOffsetMs: number,
  durationMs: number,
): AppSpan | undefined {
  return hasOnlyKeys(attrs, []) ? { name: "ui.render", startOffsetMs, durationMs } : undefined;
}

function makeDecisionSpan(
  attrs: Record<string, unknown>,
  startOffsetMs: number,
  durationMs: number,
): AppSpan | undefined {
  if (!hasOnlyKeys(attrs, ["decision"])) {
    return undefined;
  }
  const decision = attrs.decision;
  if (decision !== "approve" && decision !== "deny" && decision !== "edit") {
    return undefined;
  }
  return { name: "ui.decision", decision, startOffsetMs, durationMs };
}

function makeErrorSpan(
  attrs: Record<string, unknown>,
  startOffsetMs: number,
  durationMs: number,
): AppSpan | undefined {
  if (
    !hasOnlyKeys(attrs, ["code"]) ||
    typeof attrs.code !== "string" ||
    !/^[a-z0-9_.-]{1,64}$/u.test(attrs.code)
  ) {
    return undefined;
  }
  return { name: "ui.error", code: attrs.code, startOffsetMs, durationMs };
}

function makeInteractionSpan(
  attrs: Record<string, unknown>,
  startOffsetMs: number,
  durationMs: number,
): AppSpan | undefined {
  if (!hasOnlyKeys(attrs, ["kind", "count"])) {
    return undefined;
  }
  const kind = attrs.kind;
  const count = attrs.count;
  if (
    (kind !== "click" && kind !== "focus" && kind !== "edit") ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0 ||
    count > 1000
  ) {
    return undefined;
  }
  return { name: "ui.interaction", kind, count, startOffsetMs, durationMs };
}

function makeSpan(
  name: AppSpanName,
  attrs: unknown,
  startOffsetMs: number,
  durationMs: number,
): AppSpan | undefined {
  if (!isRecord(attrs)) {
    return undefined;
  }
  switch (name) {
    case "ui.render":
      return makeRenderSpan(attrs, startOffsetMs, durationMs);
    case "ui.decision":
      return makeDecisionSpan(attrs, startOffsetMs, durationMs);
    case "ui.error":
      return makeErrorSpan(attrs, startOffsetMs, durationMs);
    case "ui.interaction":
      return makeInteractionSpan(attrs, startOffsetMs, durationMs);
  }
}

function roundedDuration(durationMs: number): number | undefined {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > maxDurationMs) {
    return undefined;
  }
  return Math.round(durationMs);
}

function readNow(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function recordAppSpan(context: RecorderContext, input: RecordAppSpanInput): void {
  if (
    !context.active ||
    !isManifestSpanName(input.name, context.declared) ||
    context.pending.length >= maxPendingSpans
  ) {
    return;
  }
  try {
    const duration = roundedDuration(input.durationMs);
    const currentTime = input.startedAt ?? readNow(context.now);
    if (duration === undefined || context.createdAt === undefined || currentTime === undefined) {
      return;
    }
    const startOffsetMs = Math.round(currentTime - context.createdAt);
    if (startOffsetMs < 0) {
      return;
    }
    const span = makeSpan(input.name, input.attrs, startOffsetMs, duration);
    if (span !== undefined) {
      context.pending.push(span);
    }
  } catch {
    return;
  }
}

function createStart<Name extends AppSpanName>(
  context: RecorderContext,
  name: Name,
): { end(attrs?: SpanAttrs<Name>): void } {
  if (
    !context.active ||
    !isManifestSpanName(name, context.declared) ||
    context.createdAt === undefined
  ) {
    return { end: () => undefined };
  }
  const startedAt = readNow(context.now);
  return {
    end(attrs?: SpanAttrs<Name>) {
      if (startedAt === undefined || (attrs === undefined && name !== "ui.render")) {
        return;
      }
      const endedAt = readNow(context.now);
      if (endedAt !== undefined) {
        recordAppSpan(context, {
          name,
          attrs: attrs ?? {},
          durationMs: endedAt - startedAt,
          startedAt,
        });
      }
    },
  };
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

  let bridge: AppTelemetryBridge | undefined;
  let active = false;
  try {
    bridge = options.bridge;
    active = typeof bridge?.callTool === "function";
  } catch {
    bridge = undefined;
  }

  const now = options.now ?? (() => performance.now());
  const context: RecorderContext = {
    active,
    createdAt: readNow(now),
    declared,
    now,
    pending,
  };
  let activeFlush: Promise<void> | undefined;

  return {
    active,
    start<Name extends Names[number]>(name: Name): { end(attrs?: SpanAttrs<Name>): void } {
      return createStart(context, name);
    },
    record(name: Names[number], attrs: unknown, durationMs = 0) {
      recordAppSpan(context, { name, attrs, durationMs });
    },
    async flush() {
      if (!active || bridge === undefined) {
        return;
      }
      while (activeFlush !== undefined) {
        await activeFlush;
      }
      if (pending.length === 0) {
        return;
      }
      const batch = pending.slice();
      const sending = Promise.resolve().then(async () => {
        try {
          await bridge.callTool("harness.telemetry.emit", { spans: batch });
          pending.splice(0, batch.length);
        } catch {
          return;
        }
      });
      activeFlush = sending;
      try {
        await sending;
      } finally {
        activeFlush = undefined;
      }
    },
  };
}
