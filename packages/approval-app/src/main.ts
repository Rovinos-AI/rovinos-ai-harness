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
import { mountApprovalActions } from "./actions.js";
import { createApprovalTelemetry } from "./telemetry.js";
import { createApprovalView } from "./view.js";

const app = new App({ name: "harness-approval", version: "0.0.0" }, {}, { autoResize: false });
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
): Promise<unknown> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError === true) {
    return undefined;
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = result.content.find((part) => part.type === "text");
  if (text?.type !== "text") {
    return undefined;
  }
  try {
    return parseJson(
      name === "harness.approvals.resolve" ? ResolveResponse : RevealResponse,
      text.text,
    );
  } catch {
    return undefined;
  }
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
let hostUnavailable = false;
const view = createApprovalView(document.body, {
  clock: { now: () => Date.now() },
  onError: (code) => {
    uiTelemetry.reportError(hostUnavailable ? "bridge_unavailable" : code);
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
    if (approvalId === undefined) {
      for (const button of actions.querySelectorAll("button")) {
        button.disabled = true;
      }
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "Approval identifier unavailable.";
      editHost.append(status);
      return undefined;
    }
    const mountedActions = mountApprovalActions(actions, editHost, {
      approvalId,
      payload,
      isExpired,
      bridge: {
        callTool: callApprovalTool,
      },
      telemetry,
      reportError: (code) => {
        uiTelemetry.reportError(code);
      },
      decisionDurationMs: () => uiTelemetry.decisionDurationMs(),
      renderRevealed,
      onDecision,
    });
    return () => {
      mountedActions.dispose();
    };
  },
});

app.addEventListener("toolinput", (params) => {
  uiTelemetry.receivePayload(() => {
    view.receive(params.arguments);
  });
});
app.addEventListener("toolresult", (params) => {
  uiTelemetry.receivePayload(() => {
    telemetry.setHostMetadata(params._meta);
    if (params.isError === true) {
      view.receive(undefined);
      return;
    }
    if (params.structuredContent !== undefined) {
      view.receive(params.structuredContent);
      return;
    }
    const text = params.content.find((part) => part.type === "text");
    try {
      view.receive(
        text?.type === "text"
          ? parseJson(ApprovalAppInputSchema.or(ApprovalPayloadSchema), text.text)
          : undefined,
      );
    } catch {
      view.receive(undefined);
    }
  });
});
const interval = window.setInterval(() => {
  view.tick();
}, 1000);
window.addEventListener(
  "pagehide",
  () => {
    window.clearInterval(interval);
    uiTelemetry.dispose();
    view.dispose();
    void telemetry.dispose();
  },
  { once: true },
);
void app.connect().then(
  () => {
    finishHostConnection(true);
  },
  () => {
    finishHostConnection(false);
    hostUnavailable = true;
    uiTelemetry.receivePayload(() => {
      view.receive(undefined);
    });
  },
);
