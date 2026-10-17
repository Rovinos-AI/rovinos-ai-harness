// SPDX-License-Identifier: Apache-2.0
import type { AppTelemetry } from "@harness/app-telemetry";

type ApprovalAppTelemetry = AppTelemetry<
  readonly ["ui.render", "ui.decision", "ui.error", "ui.interaction"]
>;

/** Closed error codes emitted by the approval app. */
export type ApprovalUiErrorCode =
  | "payload_invalid"
  | "bridge_unavailable"
  | "resolve_failed"
  | "reveal_failed"
  | "csp_blocked"
  | "render_failed";

/** Browser globals and clock used by the approval app telemetry lifecycle. */
export interface ApprovalTelemetryEnvironment {
  readonly window: Window;
  readonly document: Document;
  readonly now: () => number;
}

/** Lifecycle hooks for metadata-only approval app spans. */
export interface ApprovalTelemetry {
  receivePayload(receive: () => void): void;
  reportError(code: ApprovalUiErrorCode): void;
  decisionDurationMs(): number;
  dispose(): void;
}

const interactionKinds = ["click", "focus", "edit"] as const;
type InteractionKind = (typeof interactionKinds)[number];

function createInteractionRecorder(telemetry: ApprovalAppTelemetry): {
  increment(kind: InteractionKind): void;
  flush(): void;
} {
  const counts: Record<InteractionKind, number> = { click: 0, focus: 0, edit: 0 };
  return {
    increment(kind) {
      counts[kind] = Math.min(1000, counts[kind] + 1);
    },
    flush() {
      for (const kind of interactionKinds) {
        const count = counts[kind];
        if (count > 0) {
          telemetry.record("ui.interaction", { kind, count });
          counts[kind] = 0;
        }
      }
    },
  };
}

interface LifecycleCallbacks {
  readonly onError: () => void;
  readonly onUnhandledRejection: () => void;
  readonly onCspViolation: () => void;
  readonly onClick: () => void;
  readonly onFocus: () => void;
  readonly onEdit: () => void;
  readonly onPageHide: () => void;
  readonly onVisibilityChange: () => void;
}

function createLifecycleCallbacks(
  environment: ApprovalTelemetryEnvironment,
  reportError: (code: ApprovalUiErrorCode) => void,
  interactions: ReturnType<typeof createInteractionRecorder>,
  flushInteractions: () => void,
): LifecycleCallbacks {
  return {
    onError: () => {
      reportError("render_failed");
    },
    onUnhandledRejection: () => {
      reportError("render_failed");
    },
    onCspViolation: () => {
      reportError("csp_blocked");
    },
    onClick: () => {
      interactions.increment("click");
    },
    onFocus: () => {
      interactions.increment("focus");
    },
    onEdit: () => {
      interactions.increment("edit");
    },
    onPageHide: () => {
      flushInteractions();
    },
    onVisibilityChange: () => {
      if (environment.document.visibilityState === "hidden") {
        flushInteractions();
      }
    },
  };
}

function installLifecycleListeners(
  environment: ApprovalTelemetryEnvironment,
  callbacks: LifecycleCallbacks,
): () => void {
  const { document, window } = environment;
  window.addEventListener("error", callbacks.onError);
  window.addEventListener("unhandledrejection", callbacks.onUnhandledRejection);
  window.addEventListener("pagehide", callbacks.onPageHide);
  document.addEventListener("securitypolicyviolation", callbacks.onCspViolation);
  document.addEventListener("click", callbacks.onClick);
  document.addEventListener("focus", callbacks.onFocus, true);
  document.addEventListener("input", callbacks.onEdit);
  document.addEventListener("visibilitychange", callbacks.onVisibilityChange);
  return () => {
    window.removeEventListener("error", callbacks.onError);
    window.removeEventListener("unhandledrejection", callbacks.onUnhandledRejection);
    window.removeEventListener("pagehide", callbacks.onPageHide);
    document.removeEventListener("securitypolicyviolation", callbacks.onCspViolation);
    document.removeEventListener("click", callbacks.onClick);
    document.removeEventListener("focus", callbacks.onFocus, true);
    document.removeEventListener("input", callbacks.onEdit);
    document.removeEventListener("visibilitychange", callbacks.onVisibilityChange);
  };
}

/**
 * Instruments approval app lifecycle events without exporting event or payload content.
 *
 * @param telemetry - Manifest-scoped host telemetry shim.
 * @param environment - Injectable browser globals and monotonic clock.
 * @returns Payload, error, interaction, and disposal hooks.
 */
export function createApprovalTelemetry(
  telemetry: ApprovalAppTelemetry,
  environment: ApprovalTelemetryEnvironment = {
    window,
    document,
    now: () => performance.now(),
  },
): ApprovalTelemetry {
  const reportedErrors = new Set<ApprovalUiErrorCode>();
  const interactions = createInteractionRecorder(telemetry);
  let renderGeneration = 0;
  let renderedAt: number | undefined;
  let disposed = false;

  const reportError = (code: ApprovalUiErrorCode): void => {
    if (disposed || reportedErrors.has(code)) {
      return;
    }
    reportedErrors.add(code);
    telemetry.record("ui.error", { code });
    void telemetry.flush();
  };

  const flushInteractions = (): void => {
    interactions.flush();
    void telemetry.flush();
  };

  const removeListeners = installLifecycleListeners(
    environment,
    createLifecycleCallbacks(environment, reportError, interactions, flushInteractions),
  );

  return {
    receivePayload(receive) {
      const generation = ++renderGeneration;
      renderedAt = undefined;
      const span = telemetry.start("ui.render");
      receive();
      environment.window.requestAnimationFrame(() => {
        environment.window.requestAnimationFrame(() => {
          const completedAt = environment.now();
          if (generation === renderGeneration) {
            renderedAt = completedAt;
          }
          span.end();
        });
      });
    },
    reportError,
    decisionDurationMs() {
      if (renderedAt === undefined) {
        return 0;
      }
      return Math.max(0, environment.now() - renderedAt);
    },
    dispose() {
      if (disposed) {
        return;
      }
      flushInteractions();
      disposed = true;
      removeListeners();
    },
  };
}
