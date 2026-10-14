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
import { createApprovalView } from "./view.js";

const app = new App({ name: "harness-approval", version: "0.0.0" }, {}, { autoResize: false });

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
    callTool: (name, args) => app.callServerTool({ name, arguments: args }),
  },
  manifest: { spans: ["ui.error", "ui.decision"] },
});
const view = createApprovalView(document.body, {
  clock: { now: () => Date.now() },
  onError: (code) => {
    telemetry.record("ui.error", { code });
    void telemetry.flush();
  },
  onPayload: ({ payload, approvalId, isExpired, actions, editHost, renderRevealed }) => {
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
      renderRevealed,
    });
    return () => {
      mountedActions.dispose();
    };
  },
});

app.addEventListener("toolinput", (params) => {
  view.receive(params.arguments);
});
app.addEventListener("toolresult", (params) => {
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
const interval = window.setInterval(() => {
  view.tick();
}, 1000);
window.addEventListener(
  "pagehide",
  () => {
    window.clearInterval(interval);
    view.dispose();
  },
  { once: true },
);
void app.connect().catch(() => {
  view.receive(undefined);
});
