// SPDX-License-Identifier: Apache-2.0
import { App } from "@modelcontextprotocol/ext-apps";
import { createAppTelemetry } from "@harness/app-telemetry";
import { ApprovalAppInputSchema } from "@harness/schemas/browser";
import { applyHostContext } from "../../kit/theme.js";
import { getStrings } from "../../kit/strings.js";
import { showApprovalTransition } from "./approval-transition.js";
import { createRunsConsoleView } from "./view.js";

const app = new App({ name: "harness-runs-console", version: "0.0.0" }, {}, { autoResize: false });
let hostContext = applyHostContext(document.documentElement, app.getHostContext());
const locale = (): string => hostContext.locale;
document.title = getStrings(locale()).runsConsoleTitle;
const connection = app.connect();
let disposeApproval: (() => void) | undefined;
let showingApproval = false;
const telemetry = createAppTelemetry({
  bridge: {
    callTool: async (name, args) => {
      await connection;
      return app.callServerTool({ name, arguments: args });
    },
  },
  hostReady: connection,
  manifest: { spans: ["ui.render", "ui.error", "ui.interaction", "ui.decision"] },
});
const runsView = createRunsConsoleView(document.body, {
  bridge: {
    callTool: async (name, args) => {
      await connection;
      return app.callServerTool({ name, arguments: args });
    },
    openApproval: async (approvalId) => {
      await connection;
      const result = await app.callServerTool({
        name: "harness.approvals.get",
        arguments: { approvalId },
      });
      if (result.isError === true || result.structuredContent === undefined) {
        throw new Error("runs_console_approval_unavailable");
      }
      const input = ApprovalAppInputSchema.parse(result.structuredContent);
      runsView.dispose();
      disposeApproval?.();
      showingApproval = true;
      document.title = getStrings(locale()).approvalTitle;
      disposeApproval = showApprovalTransition(document.body, input, {
        app,
        telemetry,
        locale,
      });
    },
  },
  telemetry,
});
const updateHostContext = (): void => {
  hostContext = applyHostContext(document.documentElement, app.getHostContext());
  document.title = getStrings(locale())[showingApproval ? "approvalTitle" : "runsConsoleTitle"];
};
app.addEventListener("hostcontextchanged", updateHostContext);

const onPageHide = (event: PageTransitionEvent): void => {
  if (event.persisted) {
    return;
  }
  app.removeEventListener("hostcontextchanged", updateHostContext);
  runsView.dispose();
  disposeApproval?.();
  void telemetry.dispose();
};
window.addEventListener("pagehide", onPageHide);
