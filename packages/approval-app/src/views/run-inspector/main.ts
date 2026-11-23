// SPDX-License-Identifier: Apache-2.0
import { App } from "@modelcontextprotocol/ext-apps";
import { createAppTelemetry } from "@rovinos/app-telemetry";
import { z } from "zod";
import {
  ApprovalAppInputSchema,
  InputAnswerRequestSchema,
  InputAnswerResponseSchema,
  InputAppInputSchema,
  RunTimelineInputSchema,
  parseJson,
} from "@rovinos/schemas/browser";
import { applyHostContext } from "../../kit/theme.js";
import { getStrings } from "../../kit/strings.js";
import { createInputView } from "../input/view.js";
import { showApprovalTransition } from "../runs-console/approval-transition.js";
import { createRunInspectorView, type RunInspectorView } from "./view.js";

const app = new App({ name: "harness-run-inspector", version: "0.0.0" }, {}, { autoResize: false });
const RUNS_RESOURCE_URI = "harness://runs";
const SUBSCRIPTION_RESULT_SCHEMA = z.object({ subscribed: z.boolean() }).strict();
const SUBSCRIPTION_CLOSED_SCHEMA = z.object({ resourceUri: z.literal(RUNS_RESOURCE_URI) }).strict();
let hostContext = applyHostContext(document.documentElement, app.getHostContext());
const locale = (): string => hostContext.locale;
document.title = getStrings(locale()).runInspectorTitle;
const connection = app.connect();
let onRunsUpdate: (() => void) | undefined;
let onRunsSubscriptionError: (() => void) | undefined;
app.setNotificationHandler("notifications/resources/updated", ({ params }) => {
  if (params.uri === RUNS_RESOURCE_URI) {
    onRunsUpdate?.();
  }
});
app.setNotificationHandler(
  "harness/resources/subscription_closed",
  { params: SUBSCRIPTION_CLOSED_SCHEMA },
  () => onRunsSubscriptionError?.(),
);

const telemetry = createAppTelemetry({
  bridge: {
    callTool: async (name, args) => {
      await connection;
      return app.callServerTool({ name, arguments: args });
    },
  },
  hostReady: connection,
  manifest: { spans: ["ui.render", "ui.error", "ui.interaction", "ui.decision", "ui.input"] },
});
let inspector: RunInspectorView | undefined;
let disposeApproval: (() => void) | undefined;
let disposeInput: (() => void) | undefined;
let activeView: "inspector" | "approval" | "input" = "inspector";
let activeRunId: string | undefined;
const runLaunchSchema = z.looseObject({ runId: z.unknown() });

function subscribeRuns(onUpdate: () => void, onError: () => void): () => void {
  onRunsUpdate = onUpdate;
  onRunsSubscriptionError = onError;
  let active = true;
  void connection
    .then(() =>
      app.request(
        {
          method: "harness/resources/subscribe",
          params: { resourceUri: RUNS_RESOURCE_URI },
        },
        SUBSCRIPTION_RESULT_SCHEMA,
      ),
    )
    .then(
      ({ subscribed }) => {
        if (active && !subscribed) {
          onError();
        }
      },
      () => {
        if (active) {
          onError();
        }
      },
    );
  return () => {
    active = false;
    if (onRunsUpdate === onUpdate) {
      onRunsUpdate = undefined;
      onRunsSubscriptionError = undefined;
    }
  };
}

async function openApproval(approvalId: string): Promise<void> {
  try {
    await connection;
    const result = await app.callServerTool({
      name: "harness.approvals.get",
      arguments: { approvalId },
    });
    if (result.isError === true || result.structuredContent === undefined) {
      throw new Error("run_inspector_approval_unavailable");
    }
    const input = ApprovalAppInputSchema.parse(result.structuredContent);
    inspector?.dispose();
    activeView = "approval";
    document.title = getStrings(locale()).approvalTitle;
    disposeApproval = showApprovalTransition(document.body, input, {
      app,
      telemetry,
      locale,
    });
  } catch {
    telemetry.record("ui.error", { code: "bridge_unavailable" });
    void telemetry.flush();
  }
}

async function openInput(requestId: string): Promise<void> {
  try {
    await connection;
    const result = await app.callServerTool({ name: "get_input", arguments: { requestId } });
    if (result.isError === true || result.structuredContent === undefined) {
      throw new Error("run_inspector_input_unavailable");
    }
    const input = InputAppInputSchema.parse(result.structuredContent);
    inspector?.dispose();
    activeView = "input";
    document.title = getStrings(locale()).inputTitle;
    const view = createInputView(document.body, {
      locale,
      onAnswer: async (request) => {
        const parsed = InputAnswerRequestSchema.safeParse(request);
        if (!parsed.success) {
          return false;
        }
        try {
          const response = await app.callServerTool({
            name: "harness.inputs.answer",
            arguments: parsed.data,
          });
          const resolved =
            response.structuredContent === undefined
              ? (() => {
                  const text = response.content.find((part) => part.type === "text");
                  if (text?.type !== "text") {
                    return undefined;
                  }
                  try {
                    return parseJson(InputAnswerResponseSchema, text.text);
                  } catch {
                    return undefined;
                  }
                })()
              : InputAnswerResponseSchema.safeParse(response.structuredContent).data;
          return response.isError !== true && resolved?.resolved === true;
        } catch {
          return false;
        }
      },
      onInputAction: (action) => {
        telemetry.record("ui.input", { action });
        void telemetry.flush();
      },
      onOpenLink: async (url) => {
        try {
          const openedLink = await app.openLink({ url });
          return openedLink.isError !== true;
        } catch {
          return false;
        }
      },
      onSelect: () => {
        telemetry.record("ui.interaction", { kind: "click", count: 1 });
        void telemetry.flush();
      },
      onError: () => {
        telemetry.record("ui.error", { code: "payload_invalid" });
        void telemetry.flush();
      },
    });
    if (!view.receive(input)) {
      view.receive(undefined);
    }
    disposeInput = () => {
      view.dispose();
    };
  } catch {
    telemetry.record("ui.error", { code: "bridge_unavailable" });
    void telemetry.flush();
  }
}

function mountInspector(runId: string): void {
  inspector?.dispose();
  disposeApproval?.();
  disposeInput?.();
  disposeApproval = undefined;
  disposeInput = undefined;
  activeRunId = runId;
  activeView = "inspector";
  document.title = getStrings(locale()).runInspectorTitle;
  inspector = createRunInspectorView(document.body, {
    runId,
    telemetry,
    bridge: {
      callTool: async (name, args) => {
        await connection;
        return app.callServerTool({ name, arguments: args });
      },
      subscribeRuns,
      openApproval,
      openInput,
    },
  });
}

function receiveRun(value: unknown): void {
  const envelope = runLaunchSchema.safeParse(value);
  if (!envelope.success) {
    document.body.replaceChildren(
      Object.assign(document.createElement("p"), {
        textContent: getStrings(locale()).runInspectorUnavailable,
      }),
    );
    return;
  }
  const parsed = RunTimelineInputSchema.safeParse({ runId: envelope.data.runId });
  if (!parsed.success) {
    document.body.replaceChildren(
      Object.assign(document.createElement("p"), {
        textContent: getStrings(locale()).runInspectorUnavailable,
      }),
    );
    return;
  }
  mountInspector(parsed.data.runId);
}

function titleForView(
  view: "inspector" | "approval" | "input",
  strings: ReturnType<typeof getStrings>,
): string {
  switch (view) {
    case "approval":
      return strings.approvalTitle;
    case "input":
      return strings.inputTitle;
    case "inspector":
      return strings.runInspectorTitle;
  }
}

app.addEventListener("toolresult", (params) => {
  telemetry.setHostMetadata(params._meta);
  if (params.isError === true || params.structuredContent === undefined) {
    receiveRun(undefined);
    return;
  }
  receiveRun(params.structuredContent);
});

const updateHostContext = (): void => {
  hostContext = applyHostContext(document.documentElement, app.getHostContext());
  document.title = titleForView(activeView, getStrings(locale()));
};
app.addEventListener("hostcontextchanged", updateHostContext);
app.onteardown = () => {
  inspector?.dispose();
  disposeApproval?.();
  disposeInput?.();
  void telemetry.dispose();
  return {};
};

const onPageHide = (event: PageTransitionEvent): void => {
  if (event.persisted) {
    return;
  }
  app.removeEventListener("hostcontextchanged", updateHostContext);
  inspector?.dispose();
  disposeApproval?.();
  disposeInput?.();
  void telemetry.dispose();
};
window.addEventListener("pagehide", onPageHide);
void connection.catch(() => {
  if (activeRunId === undefined) {
    receiveRun(undefined);
  }
});
