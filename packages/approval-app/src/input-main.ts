// SPDX-License-Identifier: Apache-2.0
import { App } from "@modelcontextprotocol/ext-apps";
import { createAppTelemetry } from "@rovinos/app-telemetry";
import {
  InputAnswerRequestSchema,
  InputAnswerResponseSchema,
  InputAppInputSchema,
  InputAppListSchema,
  parseJson,
} from "@rovinos/schemas/browser";
import { applyHostContext } from "./kit/theme.js";
import { getStrings } from "./kit/strings.js";
import { createInputView } from "./views/input/view.js";

const app = new App({ name: "harness-input", version: "0.0.0" }, {}, { autoResize: false });
let hostContext = applyHostContext(document.documentElement, app.getHostContext());
const locale = (): string => hostContext.locale;
document.title = getStrings(locale()).inputTitle;
const connection = app.connect();
const telemetry = createAppTelemetry({
  bridge: {
    callTool: async (name, args) => {
      await connection;
      return app.callServerTool({ name, arguments: args });
    },
  },
  hostReady: connection,
  manifest: { spans: ["ui.render", "ui.error", "ui.interaction", "ui.input"] },
});
let rendered = false;

function recordInputAction(
  action: "accept" | "decline" | "cancel" | "open_link" | "done",
): void {
  telemetry.record("ui.input", { action });
  void telemetry.flush();
}

function reportError(code: "input_payload_invalid" | "bridge_unavailable"): void {
  telemetry.record("ui.error", { code });
  void telemetry.flush();
}

function receiveToolResult(value: unknown): boolean {
  const parsed = InputAppInputSchema.or(InputAppListSchema).safeParse(value);
  if (!parsed.success) {
    return view.receive(undefined);
  }
  const received = view.receive(parsed.data);
  if (received && !rendered) {
    rendered = true;
    telemetry.record("ui.render", {});
    void telemetry.flush();
  }
  return received;
}

async function answerInput(value: unknown): Promise<boolean> {
  const parsed = InputAnswerRequestSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  try {
    await connection;
    const result = await app.callServerTool({
      name: "harness.inputs.answer",
      arguments: parsed.data,
    });
    const response =
      result.structuredContent === undefined
        ? (() => {
            const text = result.content.find((part) => part.type === "text");
            if (text?.type !== "text") {
              return undefined;
            }
            try {
              return parseJson(InputAnswerResponseSchema, text.text);
            } catch {
              return undefined;
            }
          })()
        : InputAnswerResponseSchema.safeParse(result.structuredContent).data;
    return result.isError !== true && response?.resolved === true;
  } catch {
    reportError("bridge_unavailable");
    return false;
  }
}

async function loadInput(requestId: string): Promise<void> {
  try {
    await connection;
    const result = await app.callServerTool({
      name: "get_input",
      arguments: { requestId },
    });
    if (result.isError === true || result.structuredContent === undefined) {
      view.receive(undefined);
      return;
    }
    receiveToolResult(result.structuredContent);
  } catch {
    reportError("bridge_unavailable");
    view.receive(undefined);
  }
}

const view = createInputView(document.body, {
  locale,
  onAnswer: answerInput,
  onInputAction: recordInputAction,
  onOpenLink: async (url) => {
    try {
      await connection;
      recordInputAction("open_link");
      const result = await app.openLink({ url });
      return result.isError !== true;
    } catch {
      reportError("bridge_unavailable");
      return false;
    }
  },
  onSelect: (requestId) => {
    void loadInput(requestId);
  },
  onError: () => {
    reportError("input_payload_invalid");
  },
});

const updateHostContext = (): void => {
  hostContext = applyHostContext(document.documentElement, app.getHostContext());
  document.title = getStrings(locale()).inputTitle;
};
app.addEventListener("hostcontextchanged", updateHostContext);
app.addEventListener("toolresult", (params) => {
  telemetry.setHostMetadata(params._meta);
  if (params.isError === true) {
    view.receive(undefined);
    return;
  }
  if (params.structuredContent !== undefined) {
    receiveToolResult(params.structuredContent);
    return;
  }
  const text = params.content.find((part) => part.type === "text");
  if (text?.type !== "text") {
    view.receive(undefined);
    return;
  }
  try {
    receiveToolResult(
      parseJson(InputAppInputSchema.or(InputAppListSchema), text.text),
    );
  } catch {
    view.receive(undefined);
  }
});
app.onteardown = () => {
  view.dispose();
  void telemetry.dispose();
  return {};
};

const onPageHide = (event: PageTransitionEvent): void => {
  if (event.persisted) {
    return;
  }
  app.removeEventListener("hostcontextchanged", updateHostContext);
  view.dispose();
  void telemetry.dispose();
};
window.addEventListener("pagehide", onPageHide);
void connection.catch(() => {
  reportError("bridge_unavailable");
  view.receive(undefined);
});
