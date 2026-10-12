// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { HarnessConfig } from "@harness/config";
import {
  APPROVAL_WAIT_SPAN,
  RunRecorder,
  foldRunState,
  resolveApproval,
  type Runtime,
  type RunState,
} from "@harness/core";
import { ApprovalPayloadSchema } from "@harness/policy";
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
import { AuditingVaultResolver, findTokens, vaultAuditToPiiAction } from "@harness/vault";
import type { VaultAuditPiiAction } from "@harness/vault";
import type { CliContext, CommandModule } from "../command.js";
import { createCommandRuntime } from "../command.js";
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

function summarize(pending: PendingApproval, now: number): ApprovalSummary {
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

function revealAudit(
  store: Store,
  context: CliContext,
  pending: PendingApproval,
): (actions: readonly VaultAuditPiiAction[]) => Promise<void> {
  return async (actions) => {
    if (actions.length === 0) {
      return;
    }
    const lastEvent = pending.events.at(-1);
    if (lastEvent === undefined) {
      return;
    }
    const recorder = new RunRecorder(
      store,
      pending.runId,
      lastEvent.segmentId,
      pending.state.nextSeq,
      context.clock,
    );
    await recorder.withStepSpan(APPROVAL_WAIT_SPAN, {}, async () => {
      const recorded = await recorder.recordBatch(actions.map((action) => ({ ...action, v: 1 })));
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new ApprovalsCodeError("failure");
      }
      return last;
    });
  };
}

function revealValue(value: JsonValue, resolve: (token: string) => string | undefined): JsonValue {
  if (typeof value === "string") {
    let offset = 0;
    let result = "";
    for (const match of findTokens(value)) {
      result += value.slice(offset, match.index) + (resolve(match.token) ?? match.token);
      offset = match.index + match.token.length;
    }
    return result + value.slice(offset);
  }
  if (Array.isArray(value)) {
    return value.map((item) => revealValue(item, resolve));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, revealValue(item, resolve)]),
    );
  }
  return value;
}

function collectTokens(value: JsonValue, tokens: Set<string>): void {
  if (typeof value === "string") {
    for (const match of findTokens(value)) {
      tokens.add(match.token);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectTokens(item, tokens);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectTokens(item, tokens);
    }
  }
}

interface RevealEnvironment {
  readonly context: CliContext;
  readonly config: HarnessConfig;
  readonly store: Store;
}

async function revealArgs(
  { context, config, store }: RevealEnvironment,
  pending: PendingApproval,
  args: JsonValue,
  toolId: string,
): Promise<JsonValue> {
  const inner = await context.createVaultResolver?.(config);
  if (inner === undefined) {
    throw new ApprovalsCodeError("reveal_unavailable");
  }
  const audits: VaultAuditPiiAction[] = [];
  const resolver = new AuditingVaultResolver(inner, (audit) => {
    audits.push(vaultAuditToPiiAction(audit));
  });
  const tokens = new Set<string>();
  collectTokens(args, tokens);
  const values = new Map<string, string>();
  try {
    if (tokens.size > 0) {
      const list = [...tokens];
      const resolved = await resolver.resolveMany(pending.runId, list, {
        boundary: "ui",
        ...(toolId === "unknown" ? {} : { toolId }),
      });
      list.forEach((token, index) => {
        const value = resolved[index];
        if (value !== undefined) {
          values.set(token, value);
        }
      });
    }
  } finally {
    await revealAudit(store, context, pending)(audits);
  }
  return revealValue(args, (token) => values.get(token));
}

async function confirm(context: CliContext, yes: boolean | undefined, question: string) {
  if (yes === true || context.interactive?.isTTY !== true) {
    return;
  }
  if (!(await context.interactive.confirm(question))) {
    throw new ApprovalsCodeError("confirmation_declined");
  }
}

async function withRuntime<T>(
  context: CliContext,
  overrides: Parameters<typeof createCommandRuntime>[2],
  action: (runtime: Runtime, config: HarnessConfig) => Promise<T>,
): Promise<T> {
  const config = await context.loadConfig();
  const runtime = await createCommandRuntime(context, config, overrides);
  try {
    return await action(runtime, config);
  } finally {
    await runtime.close();
  }
}

function registerList(approvals: Command, context: CliContext): void {
  approvals
    .command("list")
    .description("List pending approvals")
    .option("--run <id>", "only list approvals of this run")
    .action(async (options: { readonly run?: string }) => {
      const runFilter = options.run === undefined ? undefined : parseId(options.run);
      await withRuntime(context, undefined, async (runtime) => {
        const runIds = runFilter === undefined ? await suspendedRunIds(runtime.store) : [runFilter];
        const now = context.clock.now();
        const rows: ApprovalSummary[] = [];
        for (const runId of runIds) {
          for (const pending of await pendingForRun(runtime.store, runId)) {
            rows.push(summarize(pending, now));
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
    .option(
      "--reveal",
      "resolve tokens to raw values through the audited vault (implies --show-args)",
    )
    .action(
      async (
        value: string,
        options: { readonly showArgs?: boolean; readonly reveal?: boolean },
      ) => {
        const approvalId = parseId(value);
        await withRuntime(context, undefined, async (runtime, config) => {
          const pending = await findPending(runtime.store, approvalId);
          const summary = summarize(pending, context.clock.now());
          const payload = ApprovalPayloadSchema.safeParse(pending.request.payload);
          const showArgs = options.showArgs === true || options.reveal === true;
          const args = payload.success ? payload.data.args : null;
          const revealed =
            options.reveal === true
              ? await revealArgs(
                  { context, config, store: runtime.store },
                  pending,
                  args,
                  summary.toolId,
                )
              : undefined;
          if (revealed !== undefined) {
            context.out.error("reveal_exposes_sensitive_values");
          }
          const result = {
            ...summary,
            callId: pending.request.callId,
            reason: payload.success ? payload.data.reason : "unknown",
            editableFields: payload.success ? payload.data.editableFields : [],
            ...(showArgs ? { args } : {}),
            ...(revealed === undefined ? {} : { revealed }),
          };
          context.out.json(ApprovalShowResultSchema, result);
          context.out.print(`${JSON.stringify(result, null, 2)}\n`);
        });
      },
    );
}

async function decide(
  context: CliContext,
  decision: "approve" | "deny",
  value: string,
  options: DecisionOptions,
): Promise<void> {
  const approvalId = parseId(value);
  const config = await context.loadConfig();
  const tool = await context.createToolPort?.(config);
  await withRuntime(context, tool === undefined ? undefined : { tool }, async (runtime) => {
    const pending = await findPending(runtime.store, approvalId);
    const edits =
      options.edit === undefined
        ? undefined
        : parseJson(JsonValue, await readFile(options.edit, { encoding: "utf8" }));
    const edited = decision === "approve" && edits !== undefined;
    const resolution = edited ? "edit" : decision;
    const action = { approve: "Approve", edit: "Approve with edits", deny: "Deny" }[resolution];
    await confirm(context, options.yes, `${action} approval ${approvalId}?`);
    const resolved = await resolveApproval(
      runtime.store,
      pending.runId,
      approvalId,
      resolution,
      edits,
      context.clock,
      tool,
    );
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
  });
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
    .option("--resume", "resume the run immediately after resolving");
  if (decision === "approve") {
    command.option("--edit <json-file>", "replacement tool arguments (JSON file) to approve with");
  }
  command.action(async (value: string, options: DecisionOptions) => {
    await decide(context, decision, value, options);
  });
}

/** Registers the `harness approvals` command group. */
export const approvalsCommand: CommandModule = {
  name: "approvals",
  register(program, context) {
    const approvals = program.command("approvals").description("List and resolve approvals");
    registerList(approvals, context);
    registerShow(approvals, context);
    decisionCommand(approvals, context, "approve");
    decisionCommand(approvals, context, "deny");
  },
};
