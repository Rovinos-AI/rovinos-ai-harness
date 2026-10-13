// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@harness/config";
import {
  Checkpointer,
  NaiveContext,
  RunRecorder,
  RUN_SPAN,
  createRuntime,
  foldRunState,
  requestApproval,
  type ToolPort,
} from "@harness/core";
import { FakeModelPort, FakeToolPort } from "@harness/core/testing";
import { buildApprovalPayload } from "@harness/policy";
import {
  ApprovalListResultSchema,
  FakeClock,
  Id,
  JsonValue,
  Sha256Hex,
  parseJson,
  type Event,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { InMemoryVault } from "@harness/vault";
import { createTestContextManager, createTestTracerProvider } from "@harness/telemetry/testing";
import { context as otelContext, trace } from "@opentelemetry/api";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CliContext, Interactive } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { approvalsCommand } from "./approvals.js";

const EMAIL = "ada@example.test";
const config = HarnessConfigSchema.parse({});
let directory = "";
const tracerProvider = createTestTracerProvider();

beforeAll(() => {
  otelContext.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(() => {
  otelContext.disable();
  trace.disable();
});

afterEach(async () => {
  if (directory !== "") {
    await rm(directory, { recursive: true, force: true });
    directory = "";
  }
});

class EditableToolPort extends FakeToolPort {
  prepare = (call: Parameters<NonNullable<ToolPort["prepare"]>>[0]) => Promise.resolve(call);
}

interface Fixture {
  readonly context: CliContext;
  readonly store: InMemoryEventStore;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly vault: InMemoryVault;
  readonly clock: FakeClock;
  readonly prompts: string[];
  readonly nextId: () => Id;
  readonly runtimeCalls: () => number;
  readonly configLoads: () => number;
}

function createFixture(
  interactive?: Interactive,
  withVault = true,
  resumeStatus: "completed" | "suspended" = "completed",
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new InMemoryEventStore();
  const vault = new InMemoryVault();
  const clock = new FakeClock(1_000);
  const prompts: string[] = [];
  let runtimeCalls = 0;
  let configLoads = 0;
  let counter = 0;
  const nextId = (): Id => {
    counter += 1;
    return Id.parse(String(counter).padStart(26, "0"));
  };
  const out = createOutput({
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  const cliContext: CliContext = {
    loadConfig: () => {
      configLoads += 1;
      return Promise.resolve(config);
    },
    out,
    clock,
    ...(interactive === undefined ? {} : { interactive }),
    createVaultResolver: () => (withVault ? vault : undefined),
    createToolPort: () => new EditableToolPort(),
    createRuntime: async (runtimeConfig, overrides) => {
      runtimeCalls += 1;
      const runtime = await createRuntime(runtimeConfig, {
        store,
        clock,
        context: new NaiveContext(),
        tool: overrides?.tool ?? new FakeToolPort(),
        model: new FakeModelPort([]),
      });
      return {
        ...runtime,
        resume: async (runId) => {
          const events: Event[] = [];
          for await (const event of store.read(runId)) {
            events.push(event);
          }
          return { status: resumeStatus, state: foldRunState(events), approvalIds: [], events };
        },
      };
    },
  };
  return {
    context: cliContext,
    store,
    stdout,
    stderr,
    vault,
    clock,
    prompts,
    nextId,
    runtimeCalls: () => runtimeCalls,
    configLoads: () => configLoads,
  } satisfies Fixture;
}

async function seed(fixture: Fixture, args: JsonValue, ttlMs?: number) {
  const runId = fixture.nextId();
  const segmentId = fixture.nextId();
  const callId = fixture.nextId();
  const approvalId = fixture.nextId();
  const recorder = new RunRecorder(fixture.store, runId, segmentId, 0, fixture.clock);
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    const recorded = await recorder.recordBatch([
      {
        type: "run_created",
        v: 1,
        configHash: Sha256Hex.parse("a".repeat(64)),
        policyVersion: "test",
      },
      { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
      {
        type: "tool_intent",
        v: 1,
        callId,
        toolId: "send_mail",
        idempotent: false,
        policyDecision: "ask",
        argsHash: Sha256Hex.parse("b".repeat(64)),
        args,
      },
    ]);
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new Error("seed failed");
    }
    return last;
  });
  const events: Event[] = [];
  for await (const event of fixture.store.read(runId)) {
    events.push(event);
  }
  const payload = buildApprovalPayload({
    call: { callId, toolId: "send_mail", args },
    rule: { id: "mail_rule", reason: "needs_human", editable: ["/to"], approvalTtlMs: ttlMs },
    now: fixture.clock.now(),
  });
  await requestApproval(recorder, {
    approvalId,
    callId,
    payload: JsonValue.parse(payload),
    ...(ttlMs === undefined ? {} : { expiresAt: fixture.clock.now() + ttlMs }),
    state: foldRunState(events),
    checkpointer: new Checkpointer({
      recorder,
      runId,
      context: new NaiveContext(),
      ids: { next: fixture.nextId },
      clock: fixture.clock,
    }),
  });
  return { runId, approvalId };
}

async function run(fixture: Fixture, ...argv: string[]): Promise<number> {
  return runWithContext(fixture, fixture.context, ...argv);
}

async function runWithContext(
  fixture: Fixture,
  context: CliContext,
  ...argv: string[]
): Promise<number> {
  fixture.stdout.splice(0);
  fixture.stderr.splice(0);
  return main(argv, context, [approvalsCommand]);
}

async function readAll(store: InMemoryEventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("harness approvals", () => {
  it("lists pending approvals as a table and as JSON, optionally filtered by run", async () => {
    const fixture = createFixture();
    const first = await seed(fixture, { to: "<EMAIL_1>" }, 5_000);
    const second = await seed(fixture, { to: "<EMAIL_2>" });
    fixture.clock.advance(250);

    expect(await run(fixture, "approvals", "list")).toBe(ExitCode.ok);
    const table = fixture.stdout.join("");
    expect(table).toContain("approvalId\trunId\ttoolId\truleId\tageMs\texpiresAt");
    expect(table).toContain(`${first.approvalId}\t${first.runId}\tsend_mail\tmail_rule\t250\t6000`);
    expect(table).toContain(`${second.approvalId}\t${second.runId}\tsend_mail\tmail_rule\t250\t-`);

    expect(await run(fixture, "--json", "approvals", "list", "--run", second.runId)).toBe(0);
    const json = parseJson(ApprovalListResultSchema, fixture.stdout.join(""));
    expect(json.approvals.map((row) => row.approvalId)).toEqual([second.approvalId]);
    expect(await run(fixture, "approvals", "list", "--run", "nope")).toBe(ExitCode.usage);
  });

  it("hides arguments by default and shows tokenized arguments with --show-args", async () => {
    const fixture = createFixture();
    const { approvalId } = await seed(fixture, { to: "<EMAIL_1>" });

    expect(await run(fixture, "approvals", "show", approvalId)).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).not.toContain("<EMAIL_1>");
    expect(fixture.stdout.join("")).toContain('"ruleId": "mail_rule"');

    expect(await run(fixture, "approvals", "show", approvalId, "--show-args")).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).toContain("<EMAIL_1>");
    expect(fixture.stdout.join("")).not.toContain(EMAIL);
    expect(await run(fixture, "approvals", "show", "bad-id")).toBe(ExitCode.usage);
    expect(await run(fixture, "approvals", "show", fixture.nextId())).toBe(
      ExitCode.notFoundOrResolved,
    );
  });

  it("reveals values only with --reveal, warns on stderr, and audits the reveal", async () => {
    const fixture = createFixture();
    const token = "<EMAIL_1>";
    const { approvalId, runId: seededRun } = await seed(fixture, {
      to: token,
      note: `see ${token} and <PHONE_9>`,
      list: [token],
    });
    expect(await fixture.vault.put(seededRun, "email", EMAIL)).toBe(token);

    expect(await run(fixture, "approvals", "show", approvalId, "--show-args")).toBe(0);
    expect(fixture.stdout.join("")).not.toContain(EMAIL);

    expect(await run(fixture, "--json", "approvals", "show", approvalId, "--reveal")).toBe(0);
    expect(parseJson(JsonValue, fixture.stdout.join(""))).toMatchObject({
      args: { to: token },
      revealed: { to: EMAIL, note: `see ${EMAIL} and <PHONE_9>`, list: [EMAIL] },
    });
    expect(fixture.stderr.join("")).toContain("reveal_exposes_sensitive_values");

    const audits = (await readAll(fixture.store, seededRun)).filter(
      (event) => event.type === "pii_action",
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((event) => event.boundary === "ui" && event.toolId === "send_mail")).toBe(
      true,
    );
    expect(JSON.stringify(audits)).not.toContain(EMAIL);
  });

  it("fails reveal when no vault is available", async () => {
    const fixture = createFixture(undefined, false);
    const { approvalId } = await seed(fixture, { to: "<EMAIL_1>" });
    expect(await run(fixture, "approvals", "show", approvalId, "--reveal")).toBe(ExitCode.failure);
    expect(fixture.stderr.join("")).toContain("reveal_unavailable");
  });

  it("fails reveal before opening the runtime when no resolver factory is supplied", async () => {
    const fixture = createFixture();
    const { approvalId } = await seed(fixture, { to: "<EMAIL_1>" });
    const context = { ...fixture.context };
    delete context.createVaultResolver;

    expect(
      await runWithContext(fixture, context, "approvals", "show", approvalId, "--reveal"),
    ).toBe(ExitCode.failure);
    expect(fixture.stderr).toEqual(["reveal_unavailable\n"]);
    expect(fixture.stdout).toEqual([]);
    expect(fixture.runtimeCalls()).toBe(0);
  });

  it("fails edits before opening the runtime when no tool-port factory is supplied", async () => {
    directory = await mkdtemp(join(tmpdir(), "harness-approvals-"));
    const fixture = createFixture();
    const { approvalId, runId } = await seed(fixture, { to: "<EMAIL_1>" });
    const edit = join(directory, "edit.json");
    await writeFile(edit, '{"to":"<EMAIL_2>"}');
    const context = { ...fixture.context };
    delete context.createToolPort;

    expect(
      await runWithContext(
        fixture,
        context,
        "approvals",
        "approve",
        approvalId,
        "--yes",
        "--edit",
        edit,
      ),
    ).toBe(ExitCode.failure);
    expect(fixture.stderr).toEqual(["approval_edit_unavailable\n"]);
    expect(fixture.stdout).toEqual([]);
    expect(fixture.runtimeCalls()).toBe(0);
    expect(
      (await readAll(fixture.store, runId)).some((event) => event.type === "approval_resolved"),
    ).toBe(false);
  });

  it("approves, then reports already-resolved approvals with exit code 7", async () => {
    const fixture = createFixture();
    const { approvalId, runId } = await seed(fixture, { to: "<EMAIL_1>" });

    expect(await run(fixture, "approvals", "approve", approvalId, "--yes")).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).toContain(`harness resume ${runId}`);
    const resolved = (await readAll(fixture.store, runId)).find(
      (event) => event.type === "approval_resolved",
    );
    expect(resolved?.decision).toBe("approve");
    expect(await run(fixture, "approvals", "approve", approvalId, "--yes")).toBe(
      ExitCode.notFoundOrResolved,
    );
    expect(await run(fixture, "approvals", "deny", approvalId, "--yes")).toBe(
      ExitCode.notFoundOrResolved,
    );
  });

  it("denies and resumes immediately with --resume", async () => {
    const fixture = createFixture();
    const { approvalId, runId } = await seed(fixture, { to: "<EMAIL_1>" });

    const code = await run(fixture, "--json", "approvals", "deny", approvalId, "--yes", "--resume");
    expect(code).toBe(ExitCode.ok);
    expect(parseJson(JsonValue, fixture.stdout.join(""))).toMatchObject({
      decision: "deny",
      runId,
    });
    const events = await readAll(fixture.store, runId);
    expect(events.find((event) => event.type === "approval_resolved")?.decision).toBe("deny");
  });

  it("maps a still-suspended resume to exit code 5", async () => {
    const fixture = createFixture(undefined, true, "suspended");
    const { approvalId } = await seed(fixture, { to: "<EMAIL_1>" });
    expect(await run(fixture, "approvals", "approve", approvalId, "--yes", "--resume")).toBe(
      ExitCode.suspended,
    );
  });

  it("edits arguments and maps disallowed or schema-invalid edits to usage", async () => {
    directory = await mkdtemp(join(tmpdir(), "harness-approvals-"));
    const fixture = createFixture();
    const { approvalId, runId } = await seed(fixture, { to: "<EMAIL_1>", cc: "<EMAIL_2>" });
    const good = join(directory, "good.json");
    const bad = join(directory, "bad.json");
    const invalid = join(directory, "invalid.json");
    await writeFile(good, '{"to":"<EMAIL_3>","cc":"<EMAIL_2>"}');
    await writeFile(bad, '{"to":"<EMAIL_1>","cc":"<EMAIL_3>"}');
    await writeFile(invalid, '{"to":3,"cc":"<EMAIL_2>"}');

    expect(await run(fixture, "approvals", "approve", approvalId, "--yes", "--edit", bad)).toBe(
      ExitCode.usage,
    );
    expect(fixture.stderr.join("")).toContain("edit_not_allowed");
    expect(await run(fixture, "approvals", "approve", approvalId, "--yes", "--edit", good)).toBe(0);
    const resolved = (await readAll(fixture.store, runId)).find(
      (event) => event.type === "approval_resolved",
    );
    expect(resolved?.decision).toBe("edit");
    expect(resolved?.edits).toEqual({ to: "<EMAIL_3>", cc: "<EMAIL_2>" });

    const invalidFixture = createFixture();
    const schemaTool = new EditableToolPort();
    schemaTool.describe = (toolId) => {
      const metadata = new FakeToolPort(
        new Map([
          [
            "send_mail",
            {
              idempotent: false,
              timeoutMs: 1_000,
              inputSchema: {
                type: "object",
                properties: { to: { type: "string" } },
                required: ["to"],
                additionalProperties: false,
              },
              execute: () => Promise.resolve({ outcome: "ok", result: null }),
            },
          ],
        ]),
      ).describe(toolId);
      return metadata;
    };
    invalidFixture.context.createToolPort = () => schemaTool;
    await writeFile(invalid, '{"to":3}');
    const invalidApproval = await seed(invalidFixture, { to: "<EMAIL_1>" });
    expect(
      await run(
        invalidFixture,
        "approvals",
        "approve",
        invalidApproval.approvalId,
        "--yes",
        "--edit",
        invalid,
      ),
    ).toBe(ExitCode.usage);
    expect(invalidFixture.stderr.join("")).toContain("edit_invalid");
  });

  it("rejects --edit on deny", async () => {
    const fixture = createFixture();
    const { approvalId } = await seed(fixture, { to: "<EMAIL_1>" });
    expect(await run(fixture, "approvals", "deny", approvalId, "--edit", "x.json")).toBe(
      ExitCode.usage,
    );
  });

  it("gates decisions on a confirmation prompt only on a TTY without --yes", async () => {
    const answers = [false, true];
    const asked: string[] = [];
    const tty: Interactive = {
      isTTY: true,
      confirm: (question) => {
        asked.push(question);
        return Promise.resolve(answers.shift() ?? false);
      },
    };
    const fixture = createFixture(tty);
    const { approvalId, runId } = await seed(fixture, { to: "<EMAIL_1>" });

    expect(await run(fixture, "approvals", "deny", approvalId)).toBe(ExitCode.failure);
    expect(fixture.stderr.join("")).toContain("confirmation_declined");
    expect(
      (await readAll(fixture.store, runId)).some((event) => event.type === "approval_resolved"),
    ).toBe(false);
    expect(await run(fixture, "approvals", "deny", approvalId)).toBe(ExitCode.ok);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(approvalId);

    const second = await seed(fixture, { to: "<EMAIL_2>" });
    asked.length = 0;
    expect(await run(fixture, "approvals", "approve", second.approvalId, "--yes")).toBe(0);
    expect(asked).toHaveLength(0);

    const quiet = createFixture({ isTTY: false, confirm: () => Promise.resolve(false) });
    const third = await seed(quiet, { to: "<EMAIL_3>" });
    expect(await run(quiet, "approvals", "approve", third.approvalId)).toBe(ExitCode.usage);
    expect(quiet.stderr.join("")).toContain("confirmation_required");
    expect(
      (await readAll(quiet.store, third.runId)).some((event) => event.type === "approval_resolved"),
    ).toBe(false);
    expect(await run(quiet, "approvals", "approve", third.approvalId, "--yes")).toBe(ExitCode.ok);
  });

  it("loads config once for an approval decision", async () => {
    const fixture = createFixture();
    const { approvalId } = await seed(fixture, { to: "<EMAIL_1>" });
    expect(await run(fixture, "approvals", "deny", approvalId, "--yes")).toBe(ExitCode.ok);
    expect(fixture.configLoads()).toBe(1);
  });
});
