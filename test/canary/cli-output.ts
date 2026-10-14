// SPDX-License-Identifier: Apache-2.0
import { HarnessConfigSchema } from "@harness/config";
import { main, createOutput, type CliContext } from "@harness/cli/programmatic";
import { createRuntime } from "@harness/core";
import type { Event, Id } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import type { PiiEventStore } from "@harness/pii";

/** Run one read-only CLI inspection command and capture its output streams. */
export async function captureCliOutput(input: {
  readonly command: "inspect" | "context";
  readonly args: readonly string[];
  readonly runId: Id;
  readonly store: PiiEventStore;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}): Promise<void> {
  const config = HarnessConfigSchema.parse({});
  const output = createOutput({ stdout: input.stdout, stderr: input.stderr });
  const context: CliContext = {
    loadConfig: () => Promise.resolve(config),
    out: output,
    clock: { now: () => 100 },
    createRuntime: async (runtimeConfig, overrides) => {
      const cliStore = new InMemoryEventStore();
      const events: Event[] = [];
      for await (const event of input.store.read(input.runId)) {
        events.push(event);
      }
      await cliStore.append(
        input.runId,
        events.map(({ seq: _seq, ...event }) => event),
        0,
      );
      return createRuntime(runtimeConfig, {
        ...overrides,
        store: cliStore,
        transientVault: true,
      });
    },
  };
  const exitCode = await main([...input.args], context);
  if (exitCode !== 0) {
    throw new Error(
      `The canary ${input.command} command failed with exit code ${String(exitCode)}.`,
    );
  }
}
