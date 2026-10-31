// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue,
  formSchemaToZod,
  parseJson,
  type InputRequest,
  type InputResponse,
} from "@rovinos/schemas";
import type { HumanInputChannel } from "@rovinos/core";
import type { Interactive } from "./command.js";
import type { Output } from "./output.js";

class HumanInputCommandError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface PromptContext {
  readonly interactive: Interactive | undefined;
  readonly out: Output;
}

function requireInteractive(context: PromptContext): Interactive & {
  prompt(question: string, signal?: AbortSignal): Promise<string>;
} {
  const interactive = context.interactive;
  if (
    interactive?.isTTY !== true ||
    interactive.prompt === undefined ||
    interactive.confirm === undefined
  ) {
    throw new HumanInputCommandError("confirmation_required");
  }
  return {
    isTTY: true,
    confirm: interactive.confirm.bind(interactive),
    prompt: interactive.prompt.bind(interactive),
  };
}

function highlightedUrl(url: string): { readonly full: string; readonly domain: string } {
  try {
    const domain = new URL(url).hostname;
    return {
      full: url,
      domain: `\u001b[1m${domain}\u001b[22m`,
    };
  } catch {
    throw new HumanInputCommandError("input_request_invalid");
  }
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function promptForm(
  request: InputRequest,
  context: PromptContext,
  signal: AbortSignal | undefined,
): Promise<JsonValue> {
  const interactive = requireInteractive(context);
  if (request.schema === undefined) {
    const value = await interactive.prompt("Answer as a JSON value: ", signal);
    ensureNotAborted(signal);
    return parseJson(JsonValue, value);
  }
  const answer: Record<string, JsonValue> = {};
  for (const [name, field] of Object.entries(request.schema.properties)) {
    ensureNotAborted(signal);
    context.out.print(`${name} (${field.type}; constraints ${JSON.stringify(field)})\n`);
    const hasDefault = Object.hasOwn(field, "default");
    const defaultValue = hasDefault ? JsonValue.parse(field.default) : undefined;
    const value = await interactive.prompt(
      `${name}${hasDefault ? ` [${JSON.stringify(defaultValue)}]` : ""} (JSON value): `,
      signal,
    );
    if (value.length === 0 && hasDefault) {
      if (defaultValue !== undefined) {
        answer[name] = defaultValue;
      }
      continue;
    }
    if (value.length > 0) {
      answer[name] = parseJson(JsonValue, value);
    }
  }
  const parsed = formSchemaToZod(request.schema).safeParse(answer);
  if (!parsed.success) {
    throw new HumanInputCommandError("input_answer_invalid");
  }
  return JsonValue.parse(parsed.data);
}

/** Collects and reviews a terminal answer without opening any URL from an input request. */
export async function promptForInput(
  request: InputRequest,
  context: PromptContext,
  signal?: AbortSignal,
): Promise<InputResponse> {
  const interactive = requireInteractive(context);
  ensureNotAborted(signal);
  context.out.print(`${request.message}\n`);
  if (request.mode === "url") {
    if (request.url === undefined) {
      throw new HumanInputCommandError("input_request_invalid");
    }
    const displayed = highlightedUrl(request.url);
    context.out.print(`URL: ${displayed.full}\nDomain: ${displayed.domain}\n`);
    const confirmed = await interactive.confirm("Continue with this URL?");
    ensureNotAborted(signal);
    return { action: confirmed ? "accept" : "cancel" };
  }
  const answer = await promptForm(request, context, signal);
  ensureNotAborted(signal);
  context.out.print(`Review answer:\n${JSON.stringify(answer, null, 2)}\n`);
  const confirmed = await interactive.confirm("Submit this answer?");
  ensureNotAborted(signal);
  return confirmed ? { action: "accept", answer } : { action: "cancel" };
}

/** Creates the live terminal channel used by `harness run --interactive`. */
export function createTerminalInputChannel(
  interactive: Interactive | undefined,
  out: Output,
  principal: Code,
): HumanInputChannel {
  const context = { interactive, out };
  return {
    id: Code.parse("cli.terminal"),
    available: () =>
      interactive?.isTTY === true &&
      interactive.prompt !== undefined &&
      interactive.confirm !== undefined,
    present: async (request, signal) => ({
      ...(await promptForInput(request, context, signal)),
      principal,
    }),
  };
}
