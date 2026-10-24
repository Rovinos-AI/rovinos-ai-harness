// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkspace, OffloadedStub } from "@rovinos/context";
import {
  Code,
  EventSchema,
  FakeClock,
  Id,
  JsonValue,
  RunConfigSchema,
  SequentialIdGenerator,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { describe, expect, it, vi } from "vitest";
import type { ModelPort, ToolPort } from "./ports.js";
import type { ToolResumeStrategy } from "./resume-policy.js";
import { foldRunState } from "./run-state.js";
import { createRuntimeToolPort } from "./runtime-tool-composition.js";
import { setupRuntime } from "./runtime-setup.js";
import { RunScopeRegistry } from "./subagent/scope.js";

const runId = Id.parse("00000000000000000000000031");
const strategyToolId = Code.parse("test.recovery");
const rawEmail = "recovered@example.test";

describe("createRuntimeToolPort", () => {
  it("sanitizes and offloads recovered results and preserves suspend decisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-recovered-result-"));
    const store = new InMemoryEventStore();
    const workspace = new InMemoryWorkspace();
    const write = vi.spyOn(workspace, "write");
    const suspendedCallId = Id.parse("00000000000000000000000032");
    const result = JsonValue.parse({ text: `${rawEmail} ${"x".repeat(9_000)}` });
    const strategy: ToolResumeStrategy = {
      onDanglingIntent: (call) =>
        Promise.resolve(
          call.callId === suspendedCallId
            ? { kind: "suspend" as const }
            : { kind: "result" as const, execution: { outcome: "ok" as const, result } },
        ),
    };
    const baseTool: ToolPort = {
      describe: (toolId) =>
        toolId === strategyToolId ? { idempotent: false, timeoutMs: 1_000 } : undefined,
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    };
    let setup: Awaited<ReturnType<typeof setupRuntime>> | undefined;

    try {
      setup = await setupRuntime(
        { run: RunConfigSchema.parse({}) },
        {
          dataDir: directory,
          model: {
            complete: (): ReturnType<ModelPort["complete"]> =>
              Promise.reject(new Error("Unexpected model call.")),
          },
          ids: new SequentialIdGenerator(),
          clock: new FakeClock(10),
          store,
          transientVault: true,
          tool: baseTool,
          workspace,
          scopeRegistry: new RunScopeRegistry(),
        },
      );
      const innerTool = Object.assign(setup.tool, {
        resumeStrategy: (toolId: Code) => (toolId === strategyToolId ? strategy : undefined),
      });
      const tool = createRuntimeToolPort({ ...setup, tool: innerTool });
      const recovery = tool.resumeStrategy?.(strategyToolId);
      if (recovery === undefined) {
        throw new Error("Expected the wrapped recovery strategy.");
      }
      const state = foldRunState([
        EventSchema.parse({
          runId,
          seq: 0,
          ts: 1,
          v: 1,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: runId,
          type: "run_created",
          configHash: "c".repeat(64),
          policyVersion: "test.policy",
        }),
      ]);
      const context = {
        runId,
        signal: new AbortController().signal,
        toolRegistry: tool,
      };

      const recovered = await recovery.onDanglingIntent(
        {
          callId: Id.parse("00000000000000000000000033"),
          toolId: strategyToolId,
          args: JsonValue.parse({}),
        },
        state,
        context,
      );

      expect(recovered.kind).toBe("result");
      if (recovered.kind !== "result") {
        throw new Error("Expected a recovered result.");
      }
      expect(OffloadedStub.parse(recovered.execution.result).$offloaded.bytes).toBeGreaterThan(0);
      expect(write).toHaveBeenCalledOnce();
      const writeCall = write.mock.calls[0];
      if (writeCall === undefined) {
        throw new Error("Expected an offloaded result write.");
      }
      const stored = new TextDecoder().decode(await workspace.read(writeCall[0]));
      expect(stored).not.toContain(rawEmail);

      await expect(
        recovery.onDanglingIntent(
          {
            callId: suspendedCallId,
            toolId: strategyToolId,
            args: JsonValue.parse({}),
          },
          state,
          context,
        ),
      ).resolves.toEqual({ kind: "suspend" });
      expect(write).toHaveBeenCalledOnce();
    } finally {
      if (setup !== undefined) {
        await setup.closeToolPort?.();
        await setup.store.close();
        await setup.sandboxBackend.close?.();
        await setup.vault.close();
        setup.keys.dispose();
      } else {
        await store.close();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
