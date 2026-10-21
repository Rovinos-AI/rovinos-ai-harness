// SPDX-License-Identifier: Apache-2.0
import { App } from "@modelcontextprotocol/ext-apps";
import { createAppTelemetry } from "@harness/app-telemetry";
import { applyHostContext } from "../../kit/theme.js";
import { getStrings } from "../../kit/strings.js";
import { createRunsConsoleView } from "./view.js";

const app = new App({ name: "harness-runs-console", version: "0.0.0" }, {}, { autoResize: false });
let hostContext = applyHostContext(document.documentElement, app.getHostContext());
const locale = (): string => hostContext.locale;
document.title = getStrings(locale()).runsConsoleTitle;
const connection = app.connect();
const telemetry = createAppTelemetry({
  bridge: {
    callTool: async (name, args) => {
      await connection;
      return app.callServerTool({ name, arguments: args });
    },
  },
  hostReady: connection,
  manifest: { spans: ["ui.render", "ui.error", "ui.interaction"] },
});
const view = createRunsConsoleView(document.body, {
  bridge: {
    callTool: async (name, args) => {
      await connection;
      return app.callServerTool({ name, arguments: args });
    },
    openApproval: async (approvalId) => {
      await connection;
      const query = new URLSearchParams({ approvalId });
      const result = await app.openLink({ url: `ui://harness/approval/v1?${query.toString()}` });
      if (result.isError === true) {
        throw new Error("runs_console_approval_unavailable");
      }
    },
  },
  telemetry,
});
const updateHostContext = (): void => {
  hostContext = applyHostContext(document.documentElement, app.getHostContext());
  document.title = getStrings(locale()).runsConsoleTitle;
};
app.addEventListener("hostcontextchanged", updateHostContext);

const onPageHide = (event: PageTransitionEvent): void => {
  if (event.persisted) {
    return;
  }
  app.removeEventListener("hostcontextchanged", updateHostContext);
  view.dispose();
  void telemetry.dispose();
};
window.addEventListener("pagehide", onPageHide);
