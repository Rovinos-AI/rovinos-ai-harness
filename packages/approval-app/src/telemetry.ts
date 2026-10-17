// SPDX-License-Identifier: Apache-2.0
import type { AppTelemetry } from "@harness/app-telemetry";

const spanNames = ["ui.render", "ui.decision", "ui.error", "ui.interaction"] as const;

type ApprovalAppTelemetry = AppTelemetry<typeof spanNames>;

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
  const interactionCounts: Record<InteractionKind, number> = {
    click: 0,
    focus: 0,
    edit: 0,
  };
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

  const incrementInteraction = (kind: InteractionKind): void => {
    interactionCounts[kind] = Math.min(1000, interactionCounts[kind] + 1);
  };

  const flushInteractions = (): void => {
    for (const kind of interactionKinds) {
      const count = interactionCounts[kind];
      if (count > 0) {
        telemetry.record("ui.interaction", { kind, count });
        interactionCounts[kind] = 0;
      }
    }
    void telemetry.flush();
  };

  const onError = (): void => reportError("render_failed");
  const onUnhandledRejection = (): void => reportError("render_failed");
  const onCspViolation = (): void => reportError("csp_blocked");
  const onClick = (): void => incrementInteraction("click");
  const onFocus = (): void => incrementInteraction("focus");
  const onEdit = (): void => incrementInteraction("edit");
  const onPageHide = (): void => flushInteractions();
  const onVisibilityChange = (): void => {
    if (environment.document.visibilityState === "hidden") {
      flushInteractions();
    }
  };

  environment.window.addEventListener("error", onError);
  environment.window.addEventListener("unhandledrejection", onUnhandledRejection);
  environment.window.addEventListener("pagehide", onPageHide);
  environment.document.addEventListener("securitypolicyviolation", onCspViolation);
  environment.document.addEventListener("click", onClick);
  environment.document.addEventListener("focus", onFocus, true);
  environment.document.addEventListener("input", onEdit);
  environment.document.addEventListener("visibilitychange", onVisibilityChange);

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
      environment.window.removeEventListener("error", onError);
      environment.window.removeEventListener("unhandledrejection", onUnhandledRejection);
      environment.window.removeEventListener("pagehide", onPageHide);
      environment.document.removeEventListener("securitypolicyviolation", onCspViolation);
      environment.document.removeEventListener("click", onClick);
      environment.document.removeEventListener("focus", onFocus, true);
      environment.document.removeEventListener("input", onEdit);
      environment.document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}
