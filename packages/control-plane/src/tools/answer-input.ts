// SPDX-License-Identifier: Apache-2.0
import { Code, type Id, type JsonValue } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { requireControlPlaneScope, withControlPlaneAuthorization } from "../auth.js";
import type { ControlPlaneAuditHandler, ControlPlanePrincipal } from "../auth.js";
import { answerInputInputSchema, inputResolutionOutputSchema } from "../schemas.js";
import { findInputRequest, findPendingInput } from "./input-state.js";
import { INPUT_RESOURCE_URI } from "../resources/input.js";

/** Human resolution operation supplied by the composed runtime. */
export type ResolveInputOperation = (input: {
  readonly runId: Id;
  readonly requestId: Id;
  readonly action: "accept" | "decline" | "cancel";
  readonly answer?: JsonValue;
  readonly principal: string;
}) => Promise<unknown>;

/** Registers the app-only input resolution tool. */
export function registerAnswerInputTool(
  server: McpServer,
  options: {
    readonly store: EventStore;
    readonly resolveInput?: ResolveInputOperation;
    readonly isAppContext: (context: ServerContext, toolName: string) => boolean;
    readonly onAudit?: ControlPlaneAuditHandler;
  },
): void {
  const registerTool = (toolName: "answer_input" | "harness.inputs.answer"): void => {
    server.registerTool(
      toolName,
      {
        description: "Submit a human answer to a pending input request.",
        inputSchema: answerInputInputSchema,
        outputSchema: inputResolutionOutputSchema,
        annotations: { openWorldHint: false },
        _meta: {
          ui: {
            visibility: ["app"],
            ...(toolName === "harness.inputs.answer" ? { resourceUri: INPUT_RESOURCE_URI } : {}),
          },
        },
      },
      async (input, context) => {
        const parsed = answerInputInputSchema.parse(input);
        const principal = requireControlPlaneScope(
          context,
          Code.parse(toolName),
          "approve",
          options.onAudit,
        );
        const found = await findPendingInput(options.store, parsed.requestId, principal?.runIds);
        return withControlPlaneAuthorization({
          context,
          tool: Code.parse(toolName),
          scope: "approve",
          ...(found === undefined ? {} : { runId: found.runId }),
          operation: async () => {
            if (!options.isAppContext(context, toolName)) {
              return inputError("human_confirmation_unavailable");
            }
            if (found === undefined) {
              const existing = await findInputRequest(
                options.store,
                parsed.requestId,
                principal?.runIds,
              );
              return inputError(
                existing === undefined ? "input_not_found" : "input_already_resolved",
              );
            }
            if (options.resolveInput === undefined) {
              return inputError("control_plane_runtime_unavailable");
            }
            try {
              await options.resolveInput({
                runId: found.runId,
                requestId: parsed.requestId,
                action: parsed.action,
                ...(parsed.answer === undefined ? {} : { answer: parsed.answer }),
                principal: humanPrincipal(principal),
              });
              return inputResult({ resolved: true });
            } catch (error) {
              return inputError(safeErrorCode(error));
            }
          },
          audit: options.onAudit,
        });
      },
    );
  };
  registerTool("answer_input");
  registerTool("harness.inputs.answer");
}

function humanPrincipal(principal: ControlPlanePrincipal | undefined): string {
  return principal === undefined ? "cli.control_plane" : `token.${principal.tokenId}`;
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const parsed = Code.safeParse(error.code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return "input_resolution_failed";
}

function inputError(code: string) {
  const parsedCode = Code.safeParse(code);
  return inputResult({
    resolved: false,
    code: parsedCode.success ? parsedCode.data : "input_resolution_failed",
  });
}

function inputResult(value: { readonly resolved: boolean; readonly code?: string }) {
  const result = inputResolutionOutputSchema.parse(value);
  return {
    structuredContent: result,
    content: [{ type: "text" as const, text: result.code ?? "input_resolved" }],
    ...(result.resolved ? {} : { isError: true as const }),
  };
}
