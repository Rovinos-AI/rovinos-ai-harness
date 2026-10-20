// SPDX-License-Identifier: Apache-2.0
import { App } from "@modelcontextprotocol/ext-apps";
import { createAppTelemetry } from "@harness/app-telemetry";
import {
  ApprovalAppInputSchema,
  ApprovalPayloadSchema,
  ResolveResponse,
  RevealResponse,
  parseJson,
} from "@harness/schemas/browser";
import { mountApprovalActions, type ApprovalToolCallOutcome } from "./actions.js";
import { createApprovalFallback } from "./fallback.js";
import { createApprovalTelemetry } from "./telemetry.js";
import { createApprovalView } from "./view.js";
import { applyHostContext } from "./kit/theme.js";
import { getStrings } from "./kit/strings.js";

const app = new App({ name: "harness-approval", version: "0.0.0" }, {}, { autoResize: false });
let hostContext = applyHostContext(document.documentElement, app.getHostContext());
document.title = getStrings(hostContext.locale).approvalTitle;
const locale = (): string => hostContext.locale;
const fallback = createApprovalFallback(document.body, locale);
function updateHostContext(): void {
  hostContext = applyHostContext(document.documentElement, app.getHostContext());
  document.title = getStrings(hostContext.locale).approvalTitle;
}
app.addEventListener("hostcontextchanged", updateHostContext);
const unavailableToolCodes = new Set(["app_tool_not_allowed", "unknown_tool", "tool_not_found"]);
let finishHostConnection: (connected: boolean) => void = () => undefined;
const hostConnection = new Promise<void>((resolve, reject) => {
  finishHostConnection = (connected) => {
    if (connected) {
      resolve();
    } else {
      reject(new Error("host unavailable"));
    }
  };
});

async function callApprovalTool(
  name: "harness.approvals.resolve" | "harness.approvals.reveal",
  args: Record<string, unknown>,
): Promise<ApprovalToolCallOutcome> {
  let result: Awaited<ReturnType<App["callServerTool"]>>;
  try {
    result = await app.callServerTool({ name, arguments: args });
  } catch (error) {
    if (isUnavailableToolError(error)) {
      return { kind: "unavailable" };
    }
    return { kind: "failure" };
  }
  if (result.structuredContent !== undefined) {
    return { kind: "response", value: result.structuredContent };
  }
  const text = result.content.find((part) => part.type === "text");
  if (result.isError === true) {
    if (text?.type === "text") {
      try {
        return {
          kind: "response",
          value: parseJson(
            name === "harness.approvals.resolve" ? ResolveResponse : RevealResponse,
            text.text,
          ),
        };
      } catch {
        if (unavailableToolCodes.has(text.text)) {
          return { kind: "unavailable" };
        }
      }
    }
    return { kind: "failure" };
  }
  if (text?.type !== "text") {
    return { kind: "failure" };
  }
  try {
    return {
      kind: "response",
      value: parseJson(
        name === "harness.approvals.resolve" ? ResolveResponse : RevealResponse,
        text.text,
      ),
    };
  } catch {
    return { kind: "failure" };
  }
}

function isUnavailableToolError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === -32601) {
    return true;
  }
  return "message" in error && typeof error.message === "string"
    ? unavailableToolCodes.has(error.message)
    : false;
}

const telemetry = createAppTelemetry({
  bridge: {
    callTool: async (name, args) => {
      await hostConnection;
      return app.callServerTool({ name, arguments: args });
    },
  },
  hostReady: hostConnection,
  manifest: { spans: ["ui.error", "ui.decision", "ui.render", "ui.interaction"] },
});
const uiTelemetry = createApprovalTelemetry(telemetry);
let hostConnected = false;
let resolveUnavailable = false;
let markResolveUnavailable: (() => void) | undefined;
const hideFallback = (): void => {
  if (!resolveUnavailable) {
    fallback.hide();
  }
};
const fallbackTimer = window.setTimeout(() => {
  if (!hostConnected) {
    fallback.show();
  }
}, 3000);
const view = createApprovalView(document.body, {
  clock: { now: () => Date.now() },
  locale,
  onError: (code) => {
    uiTelemetry.reportError(code);
  },
  onPayload: ({
    payload,
    approvalId,
    isExpired,
    actions,
    editHost,
    renderRevealed,
    onDecision,
  }) => {
    hideFallback();
    if (resolveUnavailable) {
      fallback.show(payload.ui.fallbackText, approvalId);
    }
    if (approvalId === undefined) {
      for (const button of actions.querySelectorAll("button")) {
        button.disabled = true;
      }
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = getStrings(locale()).unavailableId;
      editHost.append(status);
      return undefined;
    }
    const markUnavailable = (): void => {
      if (resolveUnavailable) {
        return;
      }
      resolveUnavailable = true;
      uiTelemetry.reportError("bridge_unavailable");
      fallback.show(payload.ui.fallbackText, approvalId);
      for (const control of actions.querySelectorAll("button")) {
        control.disabled = true;
      }
      for (const control of editHost.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
      >("button, input, textarea")) {
        control.disabled = true;
      }
    };
    markResolveUnavailable = markUnavailable;
    const mountedActions = mountApprovalActions(actions, editHost, {
      approvalId,
      payload,
      locale,
      isExpired,
      bridge: {
        callTool: callApprovalTool,
      },
      telemetry,
      onResolveUnavailable: markUnavailable,
      reportError: (code) => {
        uiTelemetry.reportError(code);
      },
      decisionDurationMs: () => uiTelemetry.decisionDurationMs(),
      flushInteractions: () => {
        uiTelemetry.flushInteractions();
      },
      renderRevealed,
      onDecision,
    });
    if (resolveUnavailable) {
      for (const control of actions.querySelectorAll("button")) {
        control.disabled = true;
      }
      for (const control of editHost.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
      >("button, input, textarea")) {
        control.disabled = true;
      }
    }
    return () => {
      mountedActions.dispose();
      if (markResolveUnavailable === markUnavailable) {
        markResolveUnavailable = undefined;
      }
    };
  },
});

app.onteardown = () => {
  markResolveUnavailable?.();
  return {};
};

app.addEventListener("toolinput", (params) => {
  uiTelemetry.receivePayload(() => {
    return view.receive(params.arguments);
  });
});
app.addEventListener("toolresult", (params) => {
  uiTelemetry.receivePayload(() => {
    telemetry.setHostMetadata(params._meta);
    if (params.isError === true) {
      return view.receive(undefined);
    }
    if (params.structuredContent !== undefined) {
      return view.receive(params.structuredContent);
    }
    const text = params.content.find((part) => part.type === "text");
    try {
      return view.receive(
        text?.type === "text"
          ? parseJson(ApprovalAppInputSchema.or(ApprovalPayloadSchema), text.text)
          : undefined,
      );
    } catch {
      return view.receive(undefined);
    }
  });
});
const interval = window.setInterval(() => {
  view.tick();
}, 1000);
const onPageHide = (event: PageTransitionEvent): void => {
  if (event.persisted) {
    return;
  }
  window.removeEventListener("pagehide", onPageHide);
  app.removeEventListener("hostcontextchanged", updateHostContext);
  window.clearInterval(interval);
  window.clearTimeout(fallbackTimer);
  fallback.dispose();
  uiTelemetry.dispose();
  view.dispose();
  void telemetry.dispose();
};
window.addEventListener("pagehide", onPageHide);
void app.connect().then(
  () => {
    updateHostContext();
    hostConnected = true;
    window.clearTimeout(fallbackTimer);
    hideFallback();
    finishHostConnection(true);
  },
  () => {
    finishHostConnection(false);
    uiTelemetry.reportError("bridge_unavailable");
  },
);
