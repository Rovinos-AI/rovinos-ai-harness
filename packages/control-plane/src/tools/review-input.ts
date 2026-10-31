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
  HumanInputResult,
} from "../confirmation-gate.js";
import {
  inputRequestInputSchema,
  inputResolutionOutputSchema,
  type InputResolutionOutput,
} from "../schemas.js";
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

/** Dependencies and request data for one reviewed durable input. */
export interface ReviewPendingInput {
  readonly context: ServerContext;
  readonly confirmationGate: ConfirmationGate;
  readonly resolveInput: ResolveInputOperation;
  readonly clientCapabilities: (
    context: ServerContext,
  ) => ConfirmationClientCapabilities | undefined;
  readonly principal: ControlPlanePrincipal | undefined;
  readonly runId: Id;
  readonly request: InputRequest;
  readonly requestStateToken?: string;
}

type ReviewPendingInputResult = ReturnType<typeof inputRequired> | ReturnType<typeof inputResult>;

/** Reissues one pending request through the connected client and resolves its validated answer. */
export async function reviewPendingInput(
  input: ReviewPendingInput,
): Promise<ReviewPendingInputResult> {
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
  const result = await requestHumanAnswer(input, confirmationRequest);
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
  return resolveReviewedInput(input, result);
}

async function requestHumanAnswer(
  input: ReviewPendingInput,
  confirmationRequest: {
    readonly toolName: string;
    readonly targetId: Id;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly summary: string;
    readonly clientCapabilities: ConfirmationClientCapabilities | undefined;
  },
): Promise<HumanInputResult<unknown> | undefined> {
  const base = { key: "answer", capability: input.request.mode };
  if (input.request.mode === "url") {
    const url = input.request.url;
    if (url === undefined) {
      return undefined;
    }
    return await input.confirmationGate.requireHumanInput(input.context, confirmationRequest, {
      ...base,
      answerSchema: z.object({}).strict(),
      acceptWithoutContent: true,
      createRequest: (elicitationMessage) =>
        inputRequired.elicitUrl({ url, message: elicitationMessage }),
    }, input.requestStateToken);
  }
  const schema = input.request.schema;
  if (schema === undefined) {
    return undefined;
  }
  return await input.confirmationGate.requireHumanInput(input.context, confirmationRequest, {
    ...base,
    answerSchema: formSchemaToZod(schema),
    createRequest: (elicitationMessage) =>
      inputRequired.elicit({
        mode: "form",
        message: elicitationMessage,
        requestedSchema: elicitationFormSchema(schema),
      }),
  }, input.requestStateToken);
}

async function resolveReviewedInput(
  input: ReviewPendingInput,
  result: Extract<HumanInputResult<unknown>, { status: "accepted" | "declined" }>,
): Promise<ReturnType<typeof inputResult>> {
  const { request } = input;
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
    const wireProperty = { ...property };
    delete wireProperty.pattern;
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
}): {
  readonly structuredContent: InputResolutionOutput;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly isError?: true;
} {
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
