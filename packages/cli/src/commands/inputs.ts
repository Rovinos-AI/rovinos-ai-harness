// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import {
  HarnessError,
  Id,
  InputListResultSchema,
  InputRequestSchema,
  InputResolveResultSchema,
  InputShowResultSchema,
  JsonValue,
  parseJson,
  type Event,
  type InputRequest,
} from "@rovinos/schemas";
import type { Runtime } from "@rovinos/core";
import type { EventStore } from "@rovinos/store";
import type { Command } from "commander";
import type { CliContext, CommandModule } from "../command.js";
import { cliPrincipal, createCommandRuntime } from "../command.js";
import { createTerminalInputChannel, promptForInput } from "../human-input.js";

class InputsCodeError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface LocatedInput {
  readonly runId: Id;
  readonly request: InputRequest;
  readonly requestedAt: number;
  readonly pending: boolean;
}

function parseId(value: string): Id {
  const parsed = Id.safeParse(value);
  if (!parsed.success) {
    throw new InputsCodeError("usage");
  }
  return parsed.data;
}

async function* runIds(store: EventStore, onlyRunId?: Id): AsyncGenerator<Id> {
  if (onlyRunId !== undefined) {
    yield onlyRunId;
    return;
  }
  let cursor: string | undefined;
  for (;;) {
    const page = await store.listRuns({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const summary of page.runs) {
      yield summary.runId;
    }
    if (page.nextCursor === undefined || page.nextCursor === cursor) {
      return;
    }
    cursor = page.nextCursor;
  }
}

function inputRequest(event: Extract<Event, { type: "input_requested" }>): InputRequest {
  return InputRequestSchema.parse({
    requestId: event.requestId,
    source: event.source,
    ...(event.serverId === undefined ? {} : { serverId: event.serverId }),
    ...(event.callId === undefined ? {} : { callId: event.callId }),
    ...(event.inputKey === undefined ? {} : { inputKey: event.inputKey }),
    round: event.round,
    mode: event.mode,
    message: event.message,
    ...(event.schema === undefined ? {} : { schema: event.schema }),
    ...(event.url === undefined ? {} : { url: event.url }),
    ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
  });
}

async function scanInputs(
  store: EventStore,
  onlyRunId?: Id,
): Promise<LocatedInput[]> {
  const { foldRunState } = await import("@rovinos/core");
  const inputs: LocatedInput[] = [];
  for await (const runId of runIds(store, onlyRunId)) {
    const events: Event[] = [];
    for await (const event of store.read(runId)) {
      events.push(event);
    }
    if (events.length === 0) {
      continue;
    }
    const state = foldRunState(events);
    for (const [requestId, event] of state.inputRequests) {
      inputs.push({
        runId,
        request: inputRequest(event),
        requestedAt: event.ts,
        pending: state.pendingInputs.has(requestId),
      });
    }
  }
  return inputs;
}

function summary(input: LocatedInput, now: number) {
  return {
    requestId: input.request.requestId,
    runId: input.runId,
    source: input.request.source,
    mode: input.request.mode,
    ...(input.request.serverId === undefined ? {} : { serverId: input.request.serverId }),
    round: input.request.round,
    requestedAt: input.requestedAt,
    ageMs: Math.max(0, Math.floor(now - input.requestedAt)),
    expiresAt: input.request.expiresAt ?? null,
  };
}

async function findInput(
  store: EventStore,
  requestId: Id,
): Promise<LocatedInput> {
  const match = (await scanInputs(store)).find((input) => input.request.requestId === requestId);
  if (match === undefined) {
    throw new InputsCodeError("input_not_found");
  }
  if (!match.pending) {
    throw new InputsCodeError("input_already_resolved");
  }
  return match;
}

async function withInputsRuntime<T>(
  context: CliContext,
  operation: (runtime: Runtime, config: Awaited<ReturnType<CliContext["loadConfig"]>>) => Promise<T>,
): Promise<T> {
  const config = await context.loadConfig();
  const runtime = await createCommandRuntime(context, config);
  try {
    return await operation(runtime, config);
  } finally {
    await runtime.close();
  }
}

function registerList(inputs: Command, context: CliContext): void {
  inputs
    .command("list")
    .description("List pending human inputs")
    .option("--run <id>", "only list inputs for one run")
    .action(async (options: { readonly run?: string }) => {
      const runId = options.run === undefined ? undefined : parseId(options.run);
      await withInputsRuntime(context, async (runtime) => {
        const now = context.clock.now();
        const rows = (await scanInputs(runtime.store, runId))
          .filter((input) => input.pending)
          .map((input) => summary(input, now));
        context.out.json(InputListResultSchema, { inputs: rows });
        context.out.table([
          ["requestId", "runId", "source", "mode", "serverId", "round", "ageMs", "expiresAt"],
          ...rows.map((row) => [
            row.requestId,
            row.runId,
            row.source,
            row.mode,
            row.serverId ?? "-",
            row.round,
            row.ageMs,
            row.expiresAt ?? "-",
          ]),
        ]);
      });
    });
}

function registerShow(inputs: Command, context: CliContext): void {
  inputs
    .command("show")
    .description("Show one pending human input")
    .argument("<requestId>", "input request identifier")
    .option("--show-message", "include tokenized input message and schema")
    .action(async (value: string, options: { readonly showMessage?: boolean }) => {
      const requestId = parseId(value);
      await withInputsRuntime(context, async (runtime) => {
        const found = await findInput(runtime.store, requestId);
        const result = InputShowResultSchema.parse({
          ...summary(found, context.clock.now()),
          ...(options.showMessage === true
            ? {
                message: found.request.message,
                ...(found.request.schema === undefined ? {} : { schema: found.request.schema }),
                ...(found.request.url === undefined ? {} : { url: found.request.url }),
              }
            : {}),
        });
        context.out.json(InputShowResultSchema, result);
        if (inputs.optsWithGlobals().json !== true) {
          context.out.print(`${JSON.stringify(result, null, 2)}\n`);
        }
      });
    });
}

function registerAnswer(inputs: Command, context: CliContext): void {
  inputs
    .command("answer")
    .description("Answer one pending human input")
    .argument("<requestId>", "input request identifier")
    .option("--json <file>", "read the form answer from a JSON file")
    .option("--as <name>", "attribute this answer to a CLI principal")
    .action(async (value: string, options: { readonly json?: string; readonly as?: string }) => {
      const requestId = parseId(value);
      await withInputsRuntime(context, async (runtime, config) => {
        const found = await findInput(runtime.store, requestId);
        let answer: JsonValue | undefined;
        if (options.json !== undefined) {
          if (found.request.mode === "url") {
            throw new InputsCodeError("input_answer_invalid");
          }
          answer = parseJson(JsonValue, await readFile(options.json, { encoding: "utf8" }));
        } else {
          const response = await promptForInput(
            found.request,
            { interactive: context.interactive, out: context.out },
          );
          if (response.action !== "accept") {
            throw new InputsCodeError("confirmation_declined");
          }
          answer = response.answer;
        }
        await runtime.resolveInput(found.runId, requestId, {
          action: "accept",
          ...(answer === undefined ? {} : { answer }),
          principal: cliPrincipal(config, options.as),
        });
        const result = InputResolveResultSchema.parse({
          requestId,
          runId: found.runId,
          action: "accept",
        });
        context.out.json(InputResolveResultSchema, result);
        context.out.print(`${requestId} accepted\n`);
      });
    });
}

function registerDecline(inputs: Command, context: CliContext): void {
  inputs
    .command("decline")
    .description("Decline one pending human input")
    .argument("<requestId>", "input request identifier")
    .option("--as <name>", "attribute this answer to a CLI principal")
    .action(async (value: string, options: { readonly as?: string }) => {
      const requestId = parseId(value);
      await withInputsRuntime(context, async (runtime, config) => {
        const found = await findInput(runtime.store, requestId);
        await runtime.resolveInput(found.runId, requestId, {
          action: "decline",
          principal: cliPrincipal(config, options.as),
        });
        const result = InputResolveResultSchema.parse({
          requestId,
          runId: found.runId,
          action: "decline",
        });
        context.out.json(InputResolveResultSchema, result);
        context.out.print(`${requestId} declined\n`);
      });
    });
}

/** Registers the `harness inputs` command group. */
export const inputsCommand: CommandModule = {
  name: "inputs",
  /** Registers list, show, answer, and decline commands. */
  register(program, context) {
    const inputs = program.command("inputs").description("List and resolve human inputs");
    registerList(inputs, context);
    registerShow(inputs, context);
    registerAnswer(inputs, context);
    registerDecline(inputs, context);
  },
};
