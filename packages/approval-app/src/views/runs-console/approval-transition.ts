// SPDX-License-Identifier: Apache-2.0
import type { App } from "@modelcontextprotocol/ext-apps";
import type { AppTelemetry } from "@rovinos/app-telemetry";
import {
  ApprovalAppInputSchema,
  ResolveResponse,
  RevealResponse,
  parseJson,
  type ApprovalAppInput,
} from "@rovinos/schemas/browser";
import { mountApprovalActions, type ApprovalToolCallOutcome } from "../../actions.js";
import { createApprovalTelemetry } from "../../telemetry.js";
import { createApprovalView } from "../../view.js";

type ConsoleTelemetry = AppTelemetry<
  readonly ["ui.render", "ui.error", "ui.interaction", "ui.decision"]
>;

interface ApprovalTransitionOptions {
  readonly app: App;
  readonly telemetry: ConsoleTelemetry;
  readonly locale: () => string;
}

function approvalToolOutcome(
  name: "harness.approvals.resolve" | "harness.approvals.reveal",
  result: Awaited<ReturnType<App["callServerTool"]>>,
): ApprovalToolCallOutcome {
  if (result.structuredContent !== undefined) {
    return { kind: "response", value: result.structuredContent };
  }
  const text = result.content.find((part) => part.type === "text");
  if (result.isError === true && text?.type === "text") {
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

/** Replaces the run-list view with the approval view for a validated pending approval. */
export function showApprovalTransition(
  root: HTMLElement,
  input: ApprovalAppInput,
  options: ApprovalTransitionOptions,
): () => void {
  const { app, telemetry, locale } = options;
  const uiTelemetry = createApprovalTelemetry(telemetry);
  const view = createApprovalView(root, {
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
      if (approvalId === undefined) {
        return undefined;
      }
      const mounted = mountApprovalActions(actions, editHost, {
        approvalId,
        payload,
        locale,
        isExpired,
        bridge: {
          callTool: async (name, args) => {
            try {
              return approvalToolOutcome(name, await app.callServerTool({ name, arguments: args }));
            } catch {
              return { kind: "failure" };
            }
          },
        },
        telemetry,
        reportError: (code) => {
          uiTelemetry.reportError(code);
        },
        decisionDurationMs: () => {
          return uiTelemetry.decisionDurationMs();
        },
        flushInteractions: () => {
          uiTelemetry.flushInteractions();
        },
        renderRevealed,
        onDecision,
      });
      return () => {
        mounted.dispose();
      };
    },
  });
  uiTelemetry.receivePayload(() => {
    return view.receive(ApprovalAppInputSchema.parse(input));
  });
  const interval = root.ownerDocument.defaultView?.setInterval(() => {
    view.tick();
  }, 1000);
  return () => {
    if (interval !== undefined) {
      root.ownerDocument.defaultView?.clearInterval(interval);
    }
    uiTelemetry.dispose();
    view.dispose();
  };
}
