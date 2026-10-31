// SPDX-License-Identifier: Apache-2.0
import {
  FormSchema,
  JsonValue,
  ToolSpecSchema,
  type Code as CodeType,
  type ToolSpec,
} from "@rovinos/schemas";
import type {
  ModelToolCall,
  RunContext,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "../ports.js";
import type { ToolResumeStrategy } from "../resume-policy.js";
import type { RunState } from "../run-state.js";
import { z } from "zod";

const MAX_ASK_USER_EXPIRY_MS = 604_800_000;
const ASK_USER_TOOL_ID: CodeType = "agent.ask_user";
const ASK_USER_INPUT_KEY = "answer";

/** Strict model input for the built-in `agent.ask_user` tool. */
export const AskUserInputSchema = z
  .object({
    question: z.string().max(2_000),
    schema: FormSchema.optional(),
    expiresInMs: z.number().int().nonnegative().max(MAX_ASK_USER_EXPIRY_MS).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.schema !== undefined &&
      Object.values(input.schema.properties).some(
        (field) => field.type === "string" && field.pattern !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["schema"],
        message: "Regular-expression patterns are supported only for legacy requests.",
      });
    }
  });

/** Strict model output after a human resolves an `agent.ask_user` request. */
export const AskUserOutputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), answer: JsonValue }).strict(),
  z.object({ action: z.literal("decline") }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);

/** Inferred model input for `agent.ask_user`. */
export type AskUserInput = z.infer<typeof AskUserInputSchema>;

/** Inferred model output for `agent.ask_user`. */
export type AskUserOutput = z.infer<typeof AskUserOutputSchema>;

/** Model-visible specification for the durable human-input tool. */
export const ASK_USER_TOOL_SPEC: ToolSpec = ToolSpecSchema.parse({
  toolId: ASK_USER_TOOL_ID,
  description: "Ask the human a question, optionally with a structured form.",
  inputSchema: JsonValue.parse(z.toJSONSchema(AskUserInputSchema)),
});

function resultFromInputRetry(context: RunContext): ToolExecutionResult {
  const response = context.inputRetry?.inputResponses[ASK_USER_INPUT_KEY];
  if (response === undefined) {
    return { outcome: "error", errorCode: "input_request_invalid", result: null };
  }
  const parsed = AskUserOutputSchema.safeParse({
    action: response.action,
    ...(response.answer === undefined ? {} : { answer: response.answer }),
  });
  return parsed.success
    ? { outcome: "ok", result: JsonValue.parse(parsed.data) }
    : { outcome: "error", errorCode: "input_request_invalid", result: null };
}

function resolveDanglingInput(
  call: ModelToolCall,
  state: RunState,
): ToolExecutionResult | undefined {
  const requests = Array.from(state.inputRequests.values()).filter(
    (request) => request.callId === call.callId && request.source === "agent",
  );
  const request = requests.at(-1);
  if (request === undefined) {
    return undefined;
  }
  const resolution = state.resolvedInputs.get(request.requestId);
  if (resolution === undefined) {
    return { outcome: "error", errorCode: "input_request_invalid", result: null };
  }
  const parsed = AskUserOutputSchema.safeParse({
    action: resolution.action,
    ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
  });
  return parsed.success
    ? { outcome: "ok", result: JsonValue.parse(parsed.data) }
    : { outcome: "error", errorCode: "input_request_invalid", result: null };
}

/** Exposes the durable human-input request alongside an existing tool registry. */
export class AskUserTool implements ToolPort {
  /** Describes the built-in question tool. */
  describe(toolId: CodeType): ToolDescription | undefined {
    return toolId === ASK_USER_TOOL_ID ? { idempotent: false, timeoutMs: 30_000 } : undefined;
  }

  /** Advertises the `agent.ask_user` input schema. */
  getToolSpecs(): readonly ToolSpec[] {
    return [ASK_USER_TOOL_SPEC];
  }

  /** Reconstructs an answered tool result without asking the human twice. */
  resumeStrategy(toolId: CodeType): ToolResumeStrategy | undefined {
    if (toolId !== ASK_USER_TOOL_ID) {
      return undefined;
    }
    return {
      onDanglingIntent: (call, state) => {
        const result = resolveDanglingInput(call, state);
        return Promise.resolve(
          result === undefined ? { kind: "rerun" } : { kind: "result", execution: result },
        );
      },
    };
  }

  /** Records and suspends for the human's response, or returns a resolved response on resume. */
  async execute(call: ModelToolCall, context: RunContext): Promise<ToolExecutionResult> {
    if (call.toolId !== ASK_USER_TOOL_ID) {
      return { outcome: "error", errorCode: "unknown_tool", result: null };
    }
    const parsed = AskUserInputSchema.safeParse(call.args);
    if (!parsed.success) {
      return { outcome: "error", errorCode: "agent_ask_user_invalid", result: null };
    }
    if (context.inputRetry !== undefined) {
      return resultFromInputRetry(context);
    }
    if (context.askUser === undefined) {
      return { outcome: "error", errorCode: "input_request_invalid", result: null };
    }
    return context.askUser(parsed.data);
  }
}
