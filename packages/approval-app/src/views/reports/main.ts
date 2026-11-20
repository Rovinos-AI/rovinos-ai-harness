// SPDX-License-Identifier: Apache-2.0
import { App } from "@modelcontextprotocol/ext-apps";
import { parseJson } from "@rovinos/schemas/browser";
import { applyHostContext } from "../../kit/theme.js";
import { reportsViewResultSchema } from "./schema.js";
import { createReportsView } from "./view.js";

const app = new App({ name: "harness-reports", version: "0.0.0" }, {}, { autoResize: false });
let hostContext = applyHostContext(document.documentElement, app.getHostContext());
document.title = "Harness reports";
const view = createReportsView(document.body);
app.addEventListener("hostcontextchanged", updateHostContext);
app.addEventListener("toolinput", ({ arguments: input }) => {
  view.receiveInput(input);
});
app.addEventListener("toolresult", (result) => {
  if (result.isError === true) {
    view.receiveResult(undefined);
  } else if (result.structuredContent !== undefined) {
    view.receiveResult(result.structuredContent);
  } else {
    const text = result.content.find((part) => part.type === "text");
    view.receiveResult(text?.type === "text" ? parseReportText(text.text) : undefined);
  }
});
app.onteardown = () => {
  app.removeEventListener("hostcontextchanged", updateHostContext);
  return {};
};

function parseReportText(text: string): unknown {
  try {
    return parseJson(reportsViewResultSchema, text);
  } catch {
    return undefined;
  }
}

function updateHostContext(): void {
  hostContext = applyHostContext(document.documentElement, app.getHostContext());
  document.documentElement.lang = hostContext.locale;
}

void app.connect().catch(() => {
  view.receiveResult(undefined);
});
