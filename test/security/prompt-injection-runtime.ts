// SPDX-License-Identifier: Apache-2.0
import { createRuntime, type ModelPort, type PolicyPort, type ToolPort } from "@harness/core";
import { FakeModelPort, ObedientModel } from "@harness/core/testing";
import {
  FakeClock,
  Id,
  PiiConfigSchema,
  RunConfigSchema,
  type ModelRequest,
  type SequentialIdGenerator,
} from "@harness/schemas";
import type { InMemoryEventStore } from "@harness/store";
import { InProcessBackend, ensureRunWorkspace } from "@harness/sandbox";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runtime outputs needed by the prompt-injection assertions. */
export interface RuntimeScenarioResult {
  readonly result: Awaited<ReturnType<Awaited<ReturnType<typeof createRuntime>>["run"]>>;
  readonly modelRequests: readonly { readonly request: ModelRequest }[];
  readonly protectedFileContents?: string;
}

interface RuntimeScenarioOptions {
  readonly store: InMemoryEventStore;
  readonly ids: SequentialIdGenerator;
  readonly model: ModelPort;
  readonly tool: ToolPort;
  readonly policy: PolicyPort;
  readonly sandboxWrite: boolean;
  readonly flushTelemetry?: () => Promise<void>;
}

/**
 * Runs one synthetic case with the production runtime and optional in-process sandbox.
 *
 * @param options - Runtime ports and whether to include a protected-path write attempt.
 * @returns The run result, captured model requests, and protected-file contents when applicable.
 */
export async function executeRuntimeScenario(
  options: RuntimeScenarioOptions,
): Promise<RuntimeScenarioResult> {
  const sandboxRunId = Id.parse("00000000000000000000000001");
  let workspaceRoot: string | undefined;
  let protectedFilePath: string | undefined;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    let sandboxBackend: InProcessBackend | undefined;
    if (options.sandboxWrite) {
      workspaceRoot = await mkdtemp(join(tmpdir(), "injection-sandbox-"));
      sandboxBackend = new InProcessBackend({
        workspaceRoot,
        logger: { log: () => undefined },
      });
      const projectRoot = await ensureRunWorkspace(workspaceRoot, sandboxRunId);
      protectedFilePath = join(projectRoot, ".harness", "offload", "policy.json");
      await mkdir(join(projectRoot, ".harness", "offload"), { recursive: true });
      await writeFile(protectedFilePath, "protected policy");
    }
    runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({ enabled: false }),
      },
      {
        store: options.store,
        transientVault: true,
        clock: new FakeClock(100),
        ids: options.ids,
        model: options.model,
        tool: options.tool,
        policy: options.policy,
        ...(sandboxBackend === undefined ? {} : { sandboxBackend }),
      },
    );
    let result: RuntimeScenarioResult["result"];
    if (sandboxBackend === undefined) {
      result = await runtime.run("Evaluate synthetic untrusted content.");
    } else {
      const execution = runtime.start("Evaluate synthetic untrusted content.", {
        runId: sandboxRunId,
      });
      await execution.started;
      result = await execution.completion;
    }
    await options.flushTelemetry?.();
    const modelRequests =
      options.model instanceof ObedientModel || options.model instanceof FakeModelPort
        ? options.model.requests
        : [];
    return {
      result,
      modelRequests,
      ...(protectedFilePath === undefined
        ? {}
        : { protectedFileContents: await readFile(protectedFilePath, "utf8") }),
    };
  } finally {
    try {
      await runtime?.close();
    } finally {
      if (workspaceRoot !== undefined) {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    }
  }
}
