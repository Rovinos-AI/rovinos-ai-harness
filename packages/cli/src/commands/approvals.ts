// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { HarnessConfig } from "@harness/config";
import type { Runtime, RunState } from "@harness/core";
import {
  ApprovalListResultSchema,
  ApprovalResolveResultSchema,
  ApprovalShowResultSchema,
  HarnessError,
  Id,
  JsonValue,
  parseJson,
  type ApprovalSummary,
  type Event,
} from "@harness/schemas";
import type { CliContext, CommandModule } from "../command.js";
import { cliApprovalMetadata } from "../command.js";
import { waitForShutdown } from "../serve.js";
import { createApprovalResolverLease, revealApprovalArgs } from "./approval-reveal.js";
import { withApprovalRuntime } from "./approval-runtime.js";
import { runApprovalSweep } from "./approval-sweep.js";
import { assertResumeStatus } from "./resume.js";

class ApprovalsCodeError extends HarnessError {
  override readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

interface PendingApproval {
  readonly runId: Id;
  readonly state: RunState;
  readonly events: readonly Event[];
  readonly request: Extract<Event, { type: "approval_requested" }>;
}

interface DecisionOptions {
  readonly as?: string;
  readonly yes?: boolean;
  readonly resume?: boolean;
  readonly edit?: string;
}

type Store = Runtime["store"];

function parseId(value: string): Id {
  const parsed = Id.safeParse(value);
  if (!parsed.success) {
    throw new ApprovalsCodeError("usage");
  }
  return parsed.data;
}

async function readEvents(store: Store, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function suspendedRunIds(store: Store): Promise<Id[]> {
  const runIds: Id[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listRuns({
      status: "suspended",
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    runIds.push(...page.runs.map((run) => run.runId));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return runIds;
}

async function pendingForRun(store: Store, runId: Id): Promise<PendingApproval[]> {
  const events = await readEvents(store, runId);
  if (events.length === 0) {
    return [];
  }
  const { foldRunState } = await import("@harness/core");
  const state = foldRunState(events);
  return [...state.pendingApprovals.values()].map((request) => ({
    runId,
    state,
    events,
    request,
  }));
}

async function findPending(store: Store, approvalId: Id): Promise<PendingApproval> {
  for (const runId of await suspendedRunIds(store)) {
    const match = (await pendingForRun(store, runId)).find(
      (pending) => pending.request.approvalId === approvalId,
    );
    if (match !== undefined) {
      return match;
    }
  }
  throw new ApprovalsCodeError("approval_not_found");
}

async function summarize(pending: PendingApproval, now: number): Promise<ApprovalSummary> {
  const { ApprovalPayloadSchema } = await import("@harness/policy");
  const { request, state, runId } = pending;
  const payload = ApprovalPayloadSchema.safeParse(request.payload);
  return {
    approvalId: request.approvalId,
    runId,
    toolId: state.pendingToolCalls.get(request.callId)?.toolId ?? "unknown",
    ruleId: payload.success ? payload.data.ruleId : "unknown",
    requestedAt: request.ts,
    ageMs: Math.max(0, Math.floor(now - request.ts)),
    expiresAt: request.expiresAt ?? null,
  };
}

async function confirm(context: CliContext, yes: boolean | undefined, question: string) {
  if (yes === true) {
    return;
  }
  if (context.interactive?.isTTY !== true) {
    throw new ApprovalsCodeError("confirmation_required");
  }
  if (!(await context.interactive.confirm(question))) {
    throw new ApprovalsCodeError("confirmation_declined");
  }
}

function registerList(approvals: Command, context: CliContext): void {
  approvals
    .command("list")
    .description("List pending approvals")
    .option("--run <id>", "only list approvals of this run")
    .action(async (options: { readonly run?: string }) => {
      const runFilter = options.run === undefined ? undefined : parseId(options.run);
      await withApprovalRuntime(context, undefined, async (runtime) => {
        const runIds = runFilter === undefined ? await suspendedRunIds(runtime.store) : [runFilter];
        const now = context.clock.now();
        const rows: ApprovalSummary[] = [];
        for (const runId of runIds) {
          for (const pending of await pendingForRun(runtime.store, runId)) {
            rows.push(await summarize(pending, now));
          }
        }
        context.out.json(ApprovalListResultSchema, { approvals: rows });
        context.out.table([
          ["approvalId", "runId", "toolId", "ruleId", "ageMs", "expiresAt"],
          ...rows.map((row) => [
            row.approvalId,
            row.runId,
            row.toolId,
            row.ruleId,
            row.ageMs,
            row.expiresAt ?? "-",
          ]),
        ]);
      });
    });
}

function registerShow(approvals: Command, context: CliContext): void {
  approvals
    .command("show")
    .description("Show a pending approval")
    .argument("<approvalId>", "approval identifier")
    .option("--show-args", "include the tokenized tool arguments")
    .option("--view", "open the pending approval in the local reference host")
    .option(
      "--reveal",
      "resolve tokens to raw values through the audited vault (implies --show-args)",
    )
    .action(async (value: string, options: ShowOptions) =>
      showApproval({ approvals, context, approvalId: parseId(value), options }),
    );
}

interface ShowOptions {
  readonly showArgs?: boolean;
  readonly reveal?: boolean;
  readonly view?: boolean;
}

async function showApproval(input: {
  readonly approvals: Command;
  readonly context: CliContext;
  readonly approvalId: Id;
  readonly options: ShowOptions;
}): Promise<void> {
  const { approvals, context, approvalId, options } = input;
  if (options.view === true && approvals.optsWithGlobals().json === true) {
    throw new ApprovalsCodeError("approval_view_json_unsupported");
  }
  if (options.view === true && options.reveal === true) {
    throw new ApprovalsCodeError("approval_view_reveal_conflict");
  }
  const config =
    options.reveal === true || options.view === true ? await context.loadConfig() : undefined;
  if (
    options.reveal === true &&
    config?.keys === undefined &&
    context.createVaultResolver === undefined
  ) {
    throw new ApprovalsCodeError("reveal_unavailable");
  }
  await withApprovalRuntime(
    context,
    undefined,
    (runtime, runtimeConfig) =>
      showApprovalInRuntime({ approvals, context, runtime, runtimeConfig, approvalId, options }),
    { config },
  );
}

async function showApprovalInRuntime(input: {
  readonly approvals: Command;
  readonly context: CliContext;
  readonly runtime: Runtime;
  readonly runtimeConfig: HarnessConfig;
  readonly approvalId: Id;
  readonly options: ShowOptions;
}): Promise<void> {
  const resolverLease =
    input.options.reveal === true
      ? await createApprovalResolverLease(input.context, input.runtime, input.runtimeConfig)
      : undefined;
  try {
    const pending = await findPending(input.runtime.store, input.approvalId);
    if (input.options.view === true) {
      await showApprovalView({
        context: input.context,
        runtime: input.runtime,
        config: input.runtimeConfig,
        pending,
        approvalId: input.approvalId,
      });
      return;
    }
    await showApprovalDetails({ ...input, pending, resolverLease });
  } finally {
    resolverLease?.close();
  }
}

async function showApprovalView(input: {
  readonly context: CliContext;
  readonly runtime: Runtime;
  readonly config: HarnessConfig;
  readonly pending: PendingApproval;
  readonly approvalId: Id;
}): Promise<void> {
  // Loaded lazily: the view pulls in policy and vault, which plain approvals commands must not load.
  const { createApprovalViewHost } = await import("./approval-view.js");
  const host = await createApprovalViewHost({
    runtime: input.runtime,
    context: input.context,
    config: input.config,
    runId: input.pending.runId,
    approvalId: input.approvalId,
  });
  try {
    input.context.out.print(`${host.url}\n`);
    await waitForShutdown(false);
  } finally {
    await host.close();
  }
}

async function showApprovalDetails(input: {
  readonly approvals: Command;
  readonly context: CliContext;
  readonly runtime: Runtime;
  readonly approvalId: Id;
  readonly options: ShowOptions;
  readonly pending: PendingApproval;
  readonly resolverLease: Awaited<ReturnType<typeof createApprovalResolverLease>> | undefined;
}): Promise<void> {
  const summary = await summarize(input.pending, input.context.clock.now());
  const { ApprovalPayloadSchema } = await import("@harness/policy");
  const payload = ApprovalPayloadSchema.safeParse(input.pending.request.payload);
  const showArgs = input.options.showArgs === true || input.options.reveal === true;
  const args = payload.success ? payload.data.args : null;
  let revealed: JsonValue | undefined;
  if (input.options.reveal === true) {
    const resolver = input.resolverLease?.resolver;
    if (resolver === undefined) {
      throw new ApprovalsCodeError("reveal_unavailable");
    }
    revealed = await revealApprovalArgs({
      context: input.context,
      resolver,
      store: input.runtime.store,
      pending: input.pending,
      args,
      toolId: summary.toolId,
    });
  }
  if (revealed !== undefined) {
    input.context.out.error("reveal_exposes_sensitive_values");
  }
  const result = {
    ...summary,
    callId: input.pending.request.callId,
    reason: payload.success ? payload.data.reason : "unknown",
    editableFields: payload.success ? payload.data.editableFields : [],
    ...(showArgs ? { args } : {}),
    ...(revealed === undefined ? {} : { revealed }),
  };
  input.context.out.json(ApprovalShowResultSchema, result);
  if (input.approvals.optsWithGlobals().json !== true) {
    input.context.out.print(`${JSON.stringify(result, null, 2)}\n`);
  }
}

async function decide(
  context: CliContext,
  decision: "approve" | "deny",
  value: string,
  options: DecisionOptions,
): Promise<void> {
  const approvalId = parseId(value);
  const edits =
    options.edit === undefined
      ? undefined
      : parseJson(JsonValue, await readFile(options.edit, { encoding: "utf8" }));
  const config = await context.loadConfig();
  const tool = edits === undefined ? undefined : await context.createToolPort?.(config);
  if (edits !== undefined && tool === undefined && config.servers.length === 0) {
    throw new ApprovalsCodeError("approval_edit_unavailable");
  }
  await withApprovalRuntime(
    context,
    tool === undefined ? undefined : { tool },
    async (runtime) => {
      const pending = await findPending(runtime.store, approvalId);
      const edited = decision === "approve" && edits !== undefined;
      const resolution = edited ? "edit" : decision;
      const action = { approve: "Approve", edit: "Approve with edits", deny: "Deny" }[resolution];
      await confirm(context, options.yes, `${action} approval ${approvalId}?`);
      const resolved = await runtime.resolveApproval(pending.runId, approvalId, resolution, {
        ...(edits === undefined ? {} : { edits }),
        metadata: cliApprovalMetadata(config, options.as),
      });
      const resumed = options.resume === true ? await runtime.resume(pending.runId) : undefined;
      context.out.json(ApprovalResolveResultSchema, {
        approvalId,
        runId: pending.runId,
        decision: resolved.decision,
        ...(resumed === undefined ? {} : { resumedStatus: resumed.status }),
      });
      context.out.print(`${approvalId} ${resolved.decision}\n`);
      if (resumed === undefined) {
        context.out.print(`harness resume ${pending.runId}\n`);
      } else {
        assertResumeStatus(resumed.status, resumed.events);
      }
    },
    { config, disableAutoResume: options.resume === true, useQueue: true },
  );
}

function decisionCommand(
  approvals: Command,
  context: CliContext,
  decision: "approve" | "deny",
): void {
  const command = approvals
    .command(decision)
    .description(`${decision === "approve" ? "Approve" : "Deny"} a pending approval`)
    .argument("<approvalId>", "approval identifier")
    .option("--yes", "skip the confirmation prompt")
    .option("--as <name>", "attribute this decision to a CLI principal")
    .option("--resume", "resume the run immediately after resolving");
  if (decision === "approve") {
    command.option("--edit <json-file>", "replacement tool arguments (JSON file) to approve with");
  }
  command.action(async (value: string, options: DecisionOptions) => {
    await decide(context, decision, value, options);
  });
}

function registerSweep(approvals: Command, context: CliContext): void {
  approvals
    .command("sweep")
    .description("Expire and escalate pending approvals")
    .action(() =>
      withApprovalRuntime(
        context,
        undefined,
        (runtime, config) => runApprovalSweep(runtime, context, config),
        { useQueue: true },
      ),
    );
}

/** Registers the `harness approvals` command group. */
export const approvalsCommand: CommandModule = {
  name: "approvals",
  /** Registers the `approvals` command. */
  register(program, context) {
    const approvals = program.command("approvals").description("List and resolve approvals");
    registerList(approvals, context);
    registerShow(approvals, context);
    decisionCommand(approvals, context, "approve");
    decisionCommand(approvals, context, "deny");
    registerSweep(approvals, context);
  },
};
