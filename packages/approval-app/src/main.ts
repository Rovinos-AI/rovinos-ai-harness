// SPDX-License-Identifier: Apache-2.0
import { App } from "@modelcontextprotocol/ext-apps";
import { createAppTelemetry } from "@harness/app-telemetry";
import { parseJson, ApprovalPayloadSchema } from "@harness/schemas/browser";
import { createApprovalView } from "./view.js";

const app = new App({ name: "harness-approval", version: "0.0.0" }, {}, { autoResize: false });
const telemetry = createAppTelemetry({
  bridge: {
    callTool: (name, args) => app.callServerTool({ name, arguments: args }),
  },
  manifest: { spans: ["ui.error"] },
});
const view = createApprovalView(document.body, {
  clock: { now: () => Date.now() },
  onError: (code) => {
    telemetry.record("ui.error", { code });
    void telemetry.flush();
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
    view.receive(text?.type === "text" ? parseJson(ApprovalPayloadSchema, text.text) : undefined);
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
  },
  { once: true },
);
void app.connect().catch(() => {
  view.receive(undefined);
});
