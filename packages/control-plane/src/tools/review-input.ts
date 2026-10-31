// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue,
  formSchemaToZod,
  type Id,
  type InputRequest,
} from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import {
  inputRequired,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { requireControlPlaneScope, withControlPlaneAuthorization } from "../auth.js";
import type { ControlPlaneAuditHandler, ControlPlanePrincipal } from "../auth.js";
import type {
  ConfirmationClientCapabilities,
  ConfirmationGate,
} from "../confirmation-gate.js";
import { inputRequestInputSchema, inputResolutionOutputSchema } from "../schemas.js";
import type { ResolveInputOperation } from "./answer-input.js";
import { findInputRequest, findPendingInput } from "./input-state.js";

/** Registers the model-visible input review tool; human responses resolve the durable request. */
export function registerReviewInputTool(
  server: McpServer,
  options: {
    readonly store: EventStore;
    readonly confirmationGate: ConfirmationGate;
    readonly resolveInput?: ResolveInputOperation;
    readonly clientCapabilities: (
      context: ServerContext,
    ) => ConfirmationClientCapabilities | undefined;
    readonly onAudit?: ControlPlaneAuditHandler;
  },
): void {
  server.registerTool(
    "review_input",
    {
      description: "Ask a human to answer a pending input request.",
      inputSchema: inputRequestInputSchema,
      outputSchema: inputResolutionOutputSchema,
      annotations: { openWorldHint: false },
    },
    async (input, context) => {
      const parsed = inputRequestInputSchema.parse(input);
      const principal = requireControlPlaneScope(
        context,
        Code.parse("review_input"),
        "approve",
        options.onAudit,
      );
      const found = await findPendingInput(options.store, parsed.requestId, principal?.runIds);
      return withControlPlaneAuthorization({
        context,
        tool: Code.parse("review_input"),
        scope: "approve",
        ...(found === undefined ? {} : { runId: found.runId }),
        operation: async () => {
          if (found === undefined) {
            const existing = await findInputRequest(
              options.store,
              parsed.requestId,
              principal?.runIds,
            );
            return inputResult({
              resolved: false,
              code: existing === undefined ? "input_not_found" : "input_already_resolved",
            });
          }
          if (options.resolveInput === undefined) {
            return inputResult({ resolved: false, code: "control_plane_runtime_unavailable" });
          }
          return reviewPendingInput({
            ...options,
            resolveInput: options.resolveInput,
            context,
            principal,
            runId: found.runId,
            request: found.request,
          });
        },
        audit: options.onAudit,
      });
    },
  );
}

async function reviewPendingInput(input: {
  readonly context: ServerContext;
  readonly confirmationGate: ConfirmationGate;
  readonly resolveInput: ResolveInputOperation;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly principal: ControlPlanePrincipal | undefined;
  readonly runId: Id;
  readonly request: InputRequest;
}) {
  const { request } = input;
  const source =
    request.source === "agent" ? "the agent" : `MCP server ${request.serverId ?? "unknown"}`;
  const message = `Input from ${source} for run ${input.runId}: ${request.message}`;
  const confirmationRequest = {
    toolName: "review_input",
    targetId: request.requestId,
    arguments: { requestId: request.requestId },
    summary: message,
    clientCapabilities: input.clientCapabilities(input.context),
  };
  const base = { key: "answer", capability: request.mode };
  const url = request.url;
  const schema = request.schema;
  const result =
    request.mode === "url"
      ? url === undefined
        ? undefined
        : await input.confirmationGate.requireHumanInput(
            input.context,
            confirmationRequest,
            {
              ...base,
              answerSchema: z.object({}).strict(),
              acceptWithoutContent: true,
              createRequest: (elicitationMessage) =>
                inputRequired.elicitUrl({
                  url,
                  message: elicitationMessage,
                }),
            },
          )
      : schema === undefined
        ? undefined
        : await input.confirmationGate.requireHumanInput(
            input.context,
            confirmationRequest,
            {
              ...base,
              answerSchema: formSchemaToZod(schema),
              createRequest: (elicitationMessage) =>
                inputRequired.elicit({
                  mode: "form",
                  message: elicitationMessage,
                  requestedSchema: elicitationFormSchema(schema),
                }),
            },
          );
  if (result === undefined) {
    return inputResult({ resolved: false, code: "input_request_invalid" });
  }
  if (result.status === "input_required") {
    return result.result;
  }
  if (result.status === "denied") {
    if (result.code === "human_confirmation_unavailable") {
      return inputResult({
        resolved: false,
        code: result.code,
        text: `Human input is unavailable. Use the CLI: harness inputs answer ${request.requestId}.`,
      });
    }
    return inputResult({ resolved: false, code: result.code });
  }
  const action = result.status === "accepted" ? "accept" : (result.action ?? "decline");
  try {
    await input.resolveInput({
      runId: input.runId,
      requestId: request.requestId,
      action,
      ...(result.status === "accepted" && request.mode === "form"
        ? { answer: JsonValue.parse(result.content) }
        : {}),
      principal: input.principal === undefined ? "cli.control_plane" : `token.${input.principal.tokenId}`,
    });
    return inputResult({ resolved: true });
  } catch (error) {
    return inputResult({ resolved: false, code: safeErrorCode(error) });
  }
}

function elicitationFormSchema(schema: NonNullable<InputRequest["schema"]>) {
  const properties: ElicitationFormSchema["properties"] = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    properties[name] = elicitationProperty(property);
  }
  return {
    type: "object" as const,
    properties,
    ...(schema.required === undefined ? {} : { required: schema.required }),
  } satisfies ElicitationFormSchema;
}

type ElicitationFormSchema = Extract<
  Parameters<typeof inputRequired.elicit>[0]["requestedSchema"],
  { type: "object" }
>;

type ElicitationProperty = ElicitationFormSchema["properties"][string];

function elicitationProperty(
  property: NonNullable<InputRequest["schema"]>["properties"][string],
): ElicitationProperty {
  if (property.type === "string") {
    const { pattern: _pattern, ...wireProperty } = property;
    return wireProperty;
  }
  if (property.type === "array") {
    if ("anyOf" in property.items) {
      return { ...property, items: { anyOf: property.items.anyOf } };
    }
    return {
      ...property,
      items: { type: "string", enum: property.items.enum },
    };
  }
  return property;
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

function inputResult(input: {
  readonly resolved: boolean;
  readonly code?: string;
  readonly text?: string;
}) {
  const code = input.code === undefined ? undefined : Code.safeParse(input.code);
  const result = inputResolutionOutputSchema.parse({
    resolved: input.resolved,
    ...(code === undefined ? {} : { code: code.success ? code.data : "input_resolution_failed" }),
  });
  return {
    structuredContent: result,
    content: [{ type: "text" as const, text: input.text ?? result.code ?? "input_resolved" }],
    ...(result.resolved ? {} : { isError: true as const }),
  };
}
