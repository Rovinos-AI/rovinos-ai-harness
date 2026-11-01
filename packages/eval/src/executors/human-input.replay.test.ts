// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FakeClock, Id, SequentialIdGenerator } from "@rovinos/schemas";
import type { InputResponse } from "@rovinos/schemas";
import type { ModelPort, PolicyPort, RunContext, ToolPort } from "@rovinos/core";
import type { PiiToolContext } from "@rovinos/pii";
import {
  CassetteProvider,
  type CassetteEntry,
  type CassetteStore,
  type ProviderAdapter,
} from "@rovinos/models";
import { afterEach, describe, expect, it } from "vitest";
import { defineSuite } from "../load.js";
import { EvalTrialRecordSchema, TrialSpecSchema } from "../trial.js";
import { InProcessExecutor } from "./inprocess.js";
import { buildEvalReport, serializeEvalReport } from "../report/json.js";

const directories: string[] = [];
const scratch = join(process.cwd(), "packages/eval/.test-human-input");
const callId = Id.parse("00000000000000000000000011");
const policy: PolicyPort = {
  version: "test.policy",
  decide: () => ({
    decision: "allow",
    ruleId: "test.allow",
    reason: "test_allowed",
    editable: [],
  }),
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  await rm(scratch, { recursive: true, force: true });
});

describe("eval scripted human input cassette replay", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "replays two durable form/URL rounds with %s without a live provider",
    async (action) => {
      await mkdir(scratch, { recursive: true });
      const directory = await mkdtemp(join(scratch, "trial-"));
      directories.push(directory);
      const suite = defineSuite({
        schemaVersion: 1,
        tasks: [
          {
            id: "scripted_inputs",
            input: { goal: "Complete synthetic confirmations." },
            human: {
              rules: [],
              default: "deny",
              inputs: [
                {
                  match: { source: "mcp_mrtr", serverId: "sample.server", mode: "form" },
                  action,
                  ...(action === "accept" ? { answer: { confirmed: true } } : {}),
                },
                { match: { source: "mcp_mrtr", mode: "url" }, action },
              ],
            },
            graders: [],
            tags: ["human_input"],
          },
        ],
      });
      const task = suite.tasks[0];
      if (task === undefined) {
        throw new Error("synthetic_task_missing");
      }
      const entries = new Map<string, CassetteEntry>();
      const store: CassetteStore = {
        get: (hash) => Promise.resolve(entries.get(hash)?.response),
        set: (entry) => {
          entries.set(entry.hash, entry);
          return Promise.resolve();
        },
      };
      let liveCalls = 0;
      const inner: ProviderAdapter = {
        provider: "synthetic",
        kind: "openai",
        complete: () => {
          liveCalls += 1;
          return Promise.resolve({
            parts:
              liveCalls === 1
                ? [{ type: "tool_call", callId, toolId: "sample.confirm", args: {} }]
                : [{ type: "text", text: "done" }],
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: liveCalls === 1 ? "tool_calls" : "stop",
            latencyMs: 0,
          });
        },
      };

      async function execute(mode: "record" | "replay") {
        const cassette =
          mode === "record"
            ? new CassetteProvider(mode, store, inner, {
                sanitize: (result) => Promise.resolve(result),
                detectRealData: () => Promise.resolve(false),
              })
            : new CassetteProvider(mode, store);
        const model: ModelPort = {
          complete: async (request, context) => ({
            ...(await cassette.complete(request, {
              signal: context.signal,
              ids: new SequentialIdGenerator(),
              clock: new FakeClock(1),
            })),
            provider: "synthetic",
            model: "synthetic",
            providerBlobs: null,
            schemaValid: true,
            repairAttempts: 0,
            fallbackDepth: 0,
          }),
        };
        const responses: InputResponse[] = [];
        const retryStates: { round: number; requestState?: string }[] = [];
        const tool: ToolPort = {
          describe: () => ({ idempotent: true, timeoutMs: 1_000 }),
          execute: async (
            _call,
            context: RunContext & Pick<PiiToolContext, "protectInputMetadata">,
          ) => {
            if (context.inputRetry !== undefined) {
              retryStates.push({
                round: context.inputRetry.round,
                ...(context.inputRetry.requestState === undefined
                  ? {}
                  : { requestState: context.inputRetry.requestState }),
              });
              const response = context.inputRetry.inputResponses.confirmation;
              if (response === undefined) {
                throw new Error("synthetic_input_response_missing");
              }
              responses.push(response);
              if (context.inputRetry.round === 2) {
                return { outcome: "ok", result: { completed: true } };
              }
            }
            const round = context.inputRetry === undefined ? 1 : 2;
            // Injected tools must protect opaque metadata just like the production MCP bridge.
            const protect = context.protectInputMetadata;
            if (protect === undefined) {
              throw new Error("synthetic_input_protector_missing");
            }
            const inputKey = await protect("confirmation");
            const requestState = await protect(`state-${String(round)}`);
            const outcome = await context.elicitation?.handleInputRequired({
              callId,
              serverId: "sample.server",
              round,
              maxPerRun: 4,
              sensitiveInputKeys: [],
              requestState,
              inputRequests:
                round === 1
                  ? [
                      {
                        inputKey,
                        mode: "form",
                        message: "Synthetic confirmation",
                        requestedSchema: {
                          type: "object",
                          properties: { confirmed: { type: "boolean" } },
                          required: ["confirmed"],
                        },
                      },
                    ]
                  : [
                      {
                        inputKey,
                        mode: "url",
                        message: "Synthetic connection",
                        url: "https://example.test/connect",
                      },
                    ],
            });
            if (outcome?.kind !== "suspend") {
              throw new Error("synthetic_input_not_suspended");
            }
            return { outcome: "ok", result: null, suspend: true, suspendReason: "awaiting_input" };
          },
        };
        const trial = TrialSpecSchema.parse({
          suite,
          task,
          variantId: "baseline",
          variant: { id: "baseline", cassetteMode: mode },
          trialIndex: 0,
          seed: 42,
          workDir: join(directory, mode),
        });
        const executor = new InProcessExecutor({
          model: () => model,
          tool: () => tool,
          policy: () => policy,
          clock: new FakeClock(1),
          randomBytes: (size) => new Uint8Array(size).fill(1),
        });
        const result = await executor.run(trial);
        const events = executor.eventsFor(trial);
        return { result, events, responses, retryStates };
      }

      const recorded = await execute("record");
      expect(liveCalls).toBe(2);
      const replayed = await execute("replay");
      expect(
        replayed.events
          .filter((event) => event.type === "tool_result")
          .map((event) => ({ outcome: event.outcome, errorCode: event.errorCode })),
      ).toEqual([{ outcome: "ok", errorCode: undefined }]);
      expect(replayed.retryStates).toEqual([
        { round: 1, requestState: "state-1" },
        { round: 2, requestState: "state-2" },
      ]);
      expect(liveCalls).toBe(2);
      expect(replayed.result.status).toBe("completed");
      expect(replayed.result.inputs).toEqual({
        accepted: action === "accept" ? 2 : 0,
        declined: action === "decline" ? 2 : 0,
        cancelled: action === "cancel" ? 2 : 0,
      });
      expect(replayed.responses).toEqual(recorded.responses);
      expect(replayed.events.filter(({ type }) => type === "input_requested")).toHaveLength(2);
      expect(
        replayed.events
          .filter((event) => event.type === "input_resolved")
          .map((event) => ({ action: event.action, round: event.round, mode: event.mode })),
      ).toEqual(
        recorded.events
          .filter((event) => event.type === "input_resolved")
          .map((event) => ({ action: event.action, round: event.round, mode: event.mode })),
      );
      const report = serializeEvalReport(
        buildEvalReport({
          trials: [
            EvalTrialRecordSchema.parse({
              schemaVersion: 1,
              suiteCode: "eval.scripted",
              taskId: task.id,
              variantId: "baseline",
              trialIndex: 0,
              seed: 42,
              result: replayed.result,
            }),
          ],
          grades: [{ taskId: task.id, variantId: "baseline", trialIndex: 0, graders: [] }],
        }),
      );
      expect(report).toContain('"inputs"');
      expect(report).not.toContain("confirmed");
      expect(report).not.toContain("example.test");
      expect(report).not.toContain("state-");
    },
  );
});
