// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessConfigSchema } from "@rovinos/config";
import { createRuntime, type Runtime } from "@rovinos/core";
import {
  Code,
  Id,
  InputListResultSchema,
  InputResolveResultSchema,
  Principal,
  parseJson,
  type NewEvent,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CliContext, Interactive } from "../command.js";
import { ExitCode } from "../exit-codes.js";
import { main } from "../main.js";
import { createOutput } from "../output.js";
import { inputsCommand } from "./inputs.js";

const runId = Id.parse("A".repeat(26));
const requestId = Id.parse("B".repeat(26));
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const formSchema = {
  type: "object" as const,
  properties: { name: { type: "string" as const, minLength: 1 } },
  required: ["name"],
};

interface Fixture {
  readonly context: CliContext;
  readonly runtime: Runtime;
  readonly resolveInput: Mock<Runtime["resolveInput"]>;
  readonly stdout: string[];
  readonly stderr: string[];
}

const fixtures: Fixture[] = [];

async function seedInput(
  store: InMemoryEventStore,
  mode: "form" | "url" = "form",
  resolved = false,
): Promise<void> {
  const envelope = { runId, traceId, spanId, segmentId: runId };
  const events: NewEvent[] = [
    {
      ...envelope,
      ts: 1,
      v: 1,
      type: "run_created",
      configHash: "c".repeat(64),
      policyVersion: "policy.v1",
      depth: 0,
    },
    {
      ...envelope,
      ts: 2,
      v: 1,
      type: "run_status_changed",
      from: "pending",
      to: "running",
      reason: "started",
    },
    {
      ...envelope,
      ts: 3,
      v: 1,
      type: "input_requested",
      requestId,
      source: "agent",
      round: 1,
      mode,
      message: "Input message <EMAIL_1>",
      ...(mode === "form"
        ? { schema: formSchema }
        : { url: "https://accounts.example.test/connect" }),
    },
    {
      ...envelope,
      ts: 4,
      v: 1,
      type: "run_status_changed",
      from: "running",
      to: "suspended",
      reason: "awaiting_input",
    },
    ...(resolved
      ? [
          {
            ...envelope,
            ts: 5,
            v: 1,
            type: "input_resolved" as const,
            requestId,
            source: "agent" as const,
            mode,
            round: 1,
            action: "decline" as const,
            decidedBy: "human" as const,
            approverId: Principal.parse("cli.local"),
            waitMs: 2,
          },
        ]
      : []),
  ];
  await store.append(runId, events, 0);
}

async function createFixture(
  options: {
    readonly mode?: "form" | "url";
    readonly resolved?: boolean;
    readonly interactive?: Interactive;
  } = {},
): Promise<Fixture> {
  const store = new InMemoryEventStore();
  if (options.resolved !== undefined || options.mode !== undefined) {
    await seedInput(store, options.mode, options.resolved);
  } else {
    await seedInput(store);
  }
  const runtime = await createRuntime(HarnessConfigSchema.parse({}), {
    store,
    transientVault: true,
  });
  const resolutionEnvelope = {
    runId,
    traceId,
    spanId,
    segmentId: runId,
    seq: 5,
    ts: 10,
    v: 1 as const,
    type: "input_resolved" as const,
    requestId,
    source: "agent" as const,
    mode: options.mode ?? "form",
    round: 1,
    decidedBy: "human" as const,
    approverId: Principal.parse("cli.local"),
    waitMs: 7,
  };
  const resolveInput = vi
    .fn<Runtime["resolveInput"]>()
    .mockImplementation((_runId, _requestId, resolution) =>
      Promise.resolve({
        ...resolutionEnvelope,
        action: resolution.action,
        ...(resolution.answer === undefined ? {} : { answer: resolution.answer }),
      }),
    );
  const runtimeWithResolve = { ...runtime, resolveInput };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    loadConfig: () => Promise.resolve(HarnessConfigSchema.parse({})),
    out: createOutput({
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }),
    clock: { now: () => 10 },
    createRuntime: () => runtimeWithResolve,
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  };
  const fixture = { context, runtime, resolveInput, stdout, stderr };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async ({ runtime }) => {
      await runtime.close();
    }),
  );
  vi.restoreAllMocks();
});

describe("inputs CLI commands", () => {
  it("lists metadata and hides messages until show-message is requested", async () => {
    const fixture = await createFixture();

    const listCode = await main(["--json", "inputs", "list"], fixture.context, [inputsCommand]);
    const listed = parseJson(InputListResultSchema, fixture.stdout[0] ?? "");
    expect(listCode).toBe(ExitCode.ok);
    expect(listed.inputs).toHaveLength(1);
    expect(fixture.stderr.join("")).not.toContain("Input message");

    const hidden = await createFixture();
    const hiddenCode = await main(["inputs", "show", requestId], hidden.context, [inputsCommand]);
    expect(hiddenCode).toBe(ExitCode.ok);
    expect(hidden.stdout.join("")).not.toContain("Input message");
    const visible = await createFixture();
    const visibleCode = await main(
      ["inputs", "show", requestId, "--show-message"],
      visible.context,
      [inputsCommand],
    );
    expect(visibleCode).toBe(ExitCode.ok);
    expect(visible.stdout.join("")).toContain("Input message <EMAIL_1>");
  });

  it("answers a form from a fake TTY and records the CLI principal", async () => {
    const prompt = vi.fn<NonNullable<Interactive["prompt"]>>().mockResolvedValue('"Ada"');
    const confirm = vi.fn<Interactive["confirm"]>().mockResolvedValue(true);
    const fixture = await createFixture({
      interactive: { isTTY: true, prompt, confirm },
    });

    const code = await main(["inputs", "answer", requestId], fixture.context, [inputsCommand]);

    expect(code).toBe(ExitCode.ok);
    expect(prompt).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith("Submit this answer?");
    expect(fixture.resolveInput).toHaveBeenCalledWith(runId, requestId, {
      action: "accept",
      answer: { name: "Ada" },
      principal: Code.parse("cli.local"),
    });
    expect(fixture.stdout.join("")).toContain("Review answer");
  });

  it("accepts URL-mode consent only after the terminal confirmation", async () => {
    const confirm = vi.fn<Interactive["confirm"]>().mockResolvedValue(true);
    const fixture = await createFixture({
      mode: "url",
      interactive: { isTTY: true, prompt: vi.fn().mockResolvedValue(""), confirm },
    });

    const code = await main(["inputs", "answer", requestId], fixture.context, [inputsCommand]);

    expect(code).toBe(ExitCode.ok);
    expect(fixture.stdout.join("")).toContain("https://accounts.example.test/connect");
    expect(fixture.stdout.join("")).toContain(String.fromCharCode(27));
    expect(fixture.stdout.join("")).toContain("[1m");
    expect(fixture.stdout.join("")).toContain("accounts.example.test");
    expect(confirm).toHaveBeenCalledWith("Continue with this URL?");
    expect(fixture.resolveInput).toHaveBeenCalledWith(runId, requestId, {
      action: "accept",
      principal: Code.parse("cli.local"),
    });
  });

  it("declines an input and returns exit code 7 for missing or resolved requests", async () => {
    const declined = await createFixture();
    const declineCode = await main(["inputs", "decline", requestId], declined.context, [
      inputsCommand,
    ]);
    expect(declineCode).toBe(ExitCode.ok);
    expect(declined.resolveInput).toHaveBeenCalledWith(runId, requestId, {
      action: "decline",
      principal: Code.parse("cli.local"),
    });

    const missing = await createFixture();
    const missingCode = await main(["inputs", "show", Id.parse("C".repeat(26))], missing.context, [
      inputsCommand,
    ]);
    expect(missingCode).toBe(ExitCode.notFoundOrResolved);

    const resolved = await createFixture({ resolved: true });
    const resolvedCode = await main(["inputs", "answer", requestId], resolved.context, [
      inputsCommand,
    ]);
    expect(resolvedCode).toBe(ExitCode.notFoundOrResolved);
  });

  it("reads JSON form answers from a file and rejects prompts without a TTY", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-inputs-"));
    try {
      const path = join(directory, "answer.json");
      await writeFile(path, JSON.stringify({ name: "PRIVATE_INPUT_ANSWER_CANARY" }), "utf8");
      const fixture = await createFixture();

      const code = await main(["inputs", "answer", requestId, "--json", path], fixture.context, [
        inputsCommand,
      ]);
      expect(code).toBe(ExitCode.ok);
      expect(parseJson(InputResolveResultSchema, fixture.stdout[0] ?? "")).toMatchObject({
        requestId,
        action: "accept",
      });
      expect(fixture.resolveInput).toHaveBeenCalledWith(runId, requestId, {
        action: "accept",
        answer: { name: "PRIVATE_INPUT_ANSWER_CANARY" },
        principal: Code.parse("cli.local"),
      });
      expect(fixture.stdout.join("")).not.toContain("Input message");
      expect(fixture.stdout.join("")).not.toContain("PRIVATE_INPUT_ANSWER_CANARY");
      expect(fixture.stderr.join("")).not.toContain("PRIVATE_INPUT_ANSWER_CANARY");

      const nonInteractive = await createFixture();
      const noTtyCode = await main(["inputs", "answer", requestId], nonInteractive.context, [
        inputsCommand,
      ]);
      expect(noTtyCode).toBe(ExitCode.usage);
      expect(nonInteractive.stderr).toContain("confirmation_required\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
