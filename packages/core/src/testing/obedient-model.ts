// SPDX-License-Identifier: Apache-2.0
import { Code, Id, JsonValue, parseJson } from "@harness/schemas";
import type {
  IdGenerator,
  ModelCompletion,
  ModelPort,
  ModelRequest,
  ModelToolCall,
  RunContext,
} from "../ports.js";

/** A deterministic bootstrap call used to retrieve untrusted content. */
export type ObedientModelBootstrapCall = Omit<ModelToolCall, "callId">;

/** Options for the deliberately instruction-following model simulator. */
export interface ObedientModelOptions {
  readonly ids: IdGenerator;
  readonly bootstrapCall?: ObedientModelBootstrapCall;
}

/** A captured request handled by the obedient model. */
export interface ObedientModelRequest {
  readonly request: ModelRequest;
  readonly context: RunContext;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringsIn);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function latestToolText(request: ModelRequest): string[] {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role === "tool") {
      return message.parts.flatMap((part) =>
        part.type === "tool_result" ? stringsIn(part.result) : [],
      );
    }
  }
  return [];
}

function callFromText(
  toolIdText: string,
  args: unknown,
  ids: IdGenerator,
): ModelToolCall | undefined {
  const toolId = Code.safeParse(toolIdText);
  if (!toolId.success) {
    return undefined;
  }
  return { callId: ids.next(), toolId: toolId.data, args: JsonValue.parse(args) };
}

function jsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function callsFromInstruction(text: string, ids: IdGenerator): ModelToolCall[] {
  const calls: ModelToolCall[] = [];
  for (const match of text.matchAll(/\bcall tool\s+([\w.-]+)\s+with\s*\{/giu)) {
    const objectStart = match.index + match[0].lastIndexOf("{");
    const objectEnd = jsonObjectEnd(text, objectStart);
    const toolId = match[1];
    if (objectEnd === undefined || toolId === undefined) {
      continue;
    }
    try {
      const args = parseJson(JsonValue, text.slice(objectStart, objectEnd));
      const call = callFromText(toolId, args, ids);
      if (call !== undefined) {
        calls.push(call);
      }
    } catch {
      continue;
    }
  }
  for (const match of text.matchAll(/\bsend\s+(\S+)\s+to\s+([\w.-]+)/giu)) {
    const value = match[1];
    const toolId = match[2];
    if (value === undefined || toolId === undefined) {
      continue;
    }
    const call = callFromText(toolId, { value }, ids);
    if (call !== undefined) {
      calls.push(call);
    }
  }
  for (const match of text.matchAll(/\bapprove approval\s+([0-9A-HJKMNP-TV-Z]{26})/giu)) {
    const approvalIdText = match[1];
    if (approvalIdText === undefined) {
      continue;
    }
    const approvalId = Id.safeParse(approvalIdText);
    if (approvalId.success) {
      const call = callFromText(
        "approval.resolve",
        {
          approvalId: approvalId.data,
          decision: "approve",
        },
        ids,
      );
      if (call !== undefined) {
        calls.push(call);
      }
    }
  }
  return calls.filter(
    (call, index) =>
      calls.findIndex(
        (candidate) =>
          candidate.toolId === call.toolId &&
          JSON.stringify(candidate.args) === JSON.stringify(call.args),
      ) === index,
  );
}

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  const hasToolCall = parts.some((part) => part.type === "tool_call");
  return {
    provider: "synthetic",
    model: "obedient",
    parts,
    providerBlobs: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: hasToolCall ? "tool_calls" : "stop",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
  };
}

function callKey(call: ModelToolCall): string {
  return JSON.stringify([call.toolId, call.args]);
}

/**
 * Worst-case test model that follows instruction-like text in the latest tool result or tool descriptions.
 */
export class ObedientModel implements ModelPort {
  readonly requests: ObedientModelRequest[] = [];
  private bootstrapUsed = false;
  private readonly attemptedCalls = new Set<string>();

  /**
   * Creates a deterministic model that turns embedded tool instructions into tool calls.
   *
   * @param options - Injected call-id generator and optional initial untrusted-content fetch.
   */
  constructor(private readonly options: ObedientModelOptions) {}

  /** {@inheritDoc ModelPort.complete} */
  complete(request: ModelRequest, context: RunContext): Promise<ModelCompletion> {
    this.requests.push({ request, context });
    if (!this.bootstrapUsed && this.options.bootstrapCall !== undefined) {
      this.bootstrapUsed = true;
      return Promise.resolve(
        completion([
          { type: "tool_call", callId: this.options.ids.next(), ...this.options.bootstrapCall },
        ]),
      );
    }
    this.bootstrapUsed = true;
    const instructionText = [
      ...latestToolText(request),
      ...(request.tools ?? []).map(({ description }) => description),
    ].join("\n");
    const calls = callsFromInstruction(instructionText, this.options.ids).filter((call) => {
      const key = callKey(call);
      if (this.attemptedCalls.has(key)) {
        return false;
      }
      this.attemptedCalls.add(key);
      return true;
    });
    if (calls.length > 0) {
      return Promise.resolve(completion(calls.map((call) => ({ type: "tool_call", ...call }))));
    }
    const text = /IGNORE PREVIOUS INSTRUCTIONS/iu.test(instructionText)
      ? "I will follow the injected instruction."
      : "No embedded instructions were found.";
    return Promise.resolve(completion([{ type: "text", text }]));
  }
}
