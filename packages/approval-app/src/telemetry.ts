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
  receivePayload(receive: () => boolean): void;
  reportError(code: ApprovalUiErrorCode): void;
  decisionDurationMs(): number;
  flushInteractions(): void;
  dispose(): void;
}

const interactionKinds = ["click", "focus", "edit"] as const;
type InteractionKind = (typeof interactionKinds)[number];
const ambientErrorCodes = new Set<ApprovalUiErrorCode>([
  "payload_invalid",
  "csp_blocked",
  "render_failed",
]);
const maxDecisionDurationMs = 3_600_000;
const activationPollIntervalMs = 25;
const activationWaitTimeoutMs = 2_500;
const maxPendingRenderSpans = 100;

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
  window.addEventListener("pagehide", callbacks.onPageHide);
  document.addEventListener("securitypolicyviolation", callbacks.onCspViolation);
  document.addEventListener("click", callbacks.onClick);
  document.addEventListener("focus", callbacks.onFocus, true);
  document.addEventListener("input", callbacks.onEdit);
  document.addEventListener("visibilitychange", callbacks.onVisibilityChange);
  return () => {
    window.removeEventListener("error", callbacks.onError);
    window.removeEventListener("pagehide", callbacks.onPageHide);
    document.removeEventListener("securitypolicyviolation", callbacks.onCspViolation);
    document.removeEventListener("click", callbacks.onClick);
    document.removeEventListener("focus", callbacks.onFocus, true);
    document.removeEventListener("input", callbacks.onEdit);
    document.removeEventListener("visibilitychange", callbacks.onVisibilityChange);
  };
}

interface RenderState {
  generation: number;
  renderedAt: number | undefined;
}

interface RenderSpanRecorder {
  record(durationMs: number): void;
  recordError(code: ApprovalUiErrorCode): void;
  dispose(): void;
}

function releasePendingErrors(
  pendingErrors: ApprovalUiErrorCode[],
  releaseError: (code: ApprovalUiErrorCode) => void,
): void {
  for (const code of pendingErrors.splice(0)) {
    releaseError(code);
  }
}

function createRenderSpanRecorder(
  telemetry: ApprovalAppTelemetry,
  window: Window,
  releaseError: (code: ApprovalUiErrorCode) => void,
): RenderSpanRecorder {
  const pending: number[] = [];
  const pendingErrors: ApprovalUiErrorCode[] = [];
  let activationPoll: ReturnType<Window["setInterval"]> | undefined;
  let activationTimeout: ReturnType<Window["setTimeout"]> | undefined;
  let activationWaitExpired = false;

  const clearActivationTimers = (): void => {
    if (activationPoll !== undefined) {
      window.clearInterval(activationPoll);
      activationPoll = undefined;
    }
    if (activationTimeout !== undefined) {
      window.clearTimeout(activationTimeout);
      activationTimeout = undefined;
    }
  };

  const flushPending = (): void => {
    if (!telemetry.active || (pending.length === 0 && pendingErrors.length === 0)) {
      return;
    }
    clearActivationTimers();
    for (const code of pendingErrors.splice(0)) {
      telemetry.record("ui.error", { code });
    }
    for (const durationMs of pending.splice(0)) {
      telemetry.record("ui.render", {}, durationMs);
    }
    void telemetry.flush();
  };

  const waitForActivation = (): void => {
    if (activationWaitExpired || activationPoll !== undefined) {
      return;
    }
    activationPoll = window.setInterval(flushPending, activationPollIntervalMs);
    activationTimeout = window.setTimeout(() => {
      clearActivationTimers();
      activationWaitExpired = true;
      pending.length = 0;
      releasePendingErrors(pendingErrors, releaseError);
    }, activationWaitTimeoutMs);
  };

  return {
    record(durationMs) {
      if (telemetry.active) {
        telemetry.record("ui.render", {}, durationMs);
        void telemetry.flush();
        return;
      }
      if (pending.length === maxPendingRenderSpans) {
        pending.shift();
      }
      pending.push(durationMs);
      waitForActivation();
    },
    recordError(code) {
      if (telemetry.active) {
        telemetry.record("ui.error", { code });
        void telemetry.flush();
        return;
      }
      if (activationWaitExpired) {
        return;
      }
      if (pendingErrors.length === maxPendingRenderSpans) {
        pendingErrors.shift();
      }
      pendingErrors.push(code);
      waitForActivation();
    },
    dispose() {
      clearActivationTimers();
      pending.length = 0;
      pendingErrors.length = 0;
    },
  };
}

interface RenderLifecycle {
  receive(receive: () => boolean): void;
  decisionDurationMs(): number;
}

function createRenderLifecycle(
  environment: ApprovalTelemetryEnvironment,
  reportError: (code: ApprovalUiErrorCode) => void,
  renderSpans: RenderSpanRecorder,
): RenderLifecycle {
  const renderState: RenderState = { generation: 0, renderedAt: undefined };
  return {
    receive(receive) {
      const receivedAt = environment.now();
      let contentChanged = true;
      try {
        contentChanged = receive();
      } catch {
        reportError("render_failed");
      }
      if (contentChanged) {
        renderState.generation += 1;
        renderState.renderedAt = undefined;
      }
      const generation = renderState.generation;
      environment.window.requestAnimationFrame(() => {
        environment.window.requestAnimationFrame(() => {
          const completedAt = environment.now();
          if (generation === renderState.generation && renderState.renderedAt === undefined) {
            renderState.renderedAt = completedAt;
          }
          renderSpans.record(Math.max(0, completedAt - receivedAt));
        });
      });
    },
    decisionDurationMs() {
      if (renderState.renderedAt === undefined) {
        return 0;
      }
      const durationMs = environment.now() - renderState.renderedAt;
      return Number.isFinite(durationMs)
        ? Math.min(maxDecisionDurationMs, Math.max(0, durationMs))
        : 0;
    },
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
  const renderSpans = createRenderSpanRecorder(telemetry, environment.window, (code) => {
    reportedErrors.delete(code);
  });
  let disposed = false;

  const reportError = (code: ApprovalUiErrorCode): void => {
    if (disposed) {
      return;
    }
    if (ambientErrorCodes.has(code)) {
      if (reportedErrors.has(code)) {
        return;
      }
      reportedErrors.add(code);
    }
    renderSpans.recordError(code);
  };
  const renderLifecycle = createRenderLifecycle(environment, reportError, renderSpans);

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
      renderLifecycle.receive(receive);
    },
    reportError,
    decisionDurationMs() {
      return renderLifecycle.decisionDurationMs();
    },
    flushInteractions,
    dispose() {
      if (disposed) {
        return;
      }
      flushInteractions();
      disposed = true;
      renderSpans.dispose();
      removeListeners();
    },
  };
}
