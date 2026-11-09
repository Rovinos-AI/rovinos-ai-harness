// SPDX-License-Identifier: Apache-2.0
import type { McpToolPort } from "@rovinos/mcp";
import type { RateLimitStore } from "@rovinos/schemas";
import type { EventStore } from "@rovinos/store";
import type { SandboxBackend } from "@rovinos/sandbox";
import type { RuntimeComposition, RuntimeVault } from "./runtime-config.js";

/** Closes partially created runtime resources in dependency order, attempting every cleanup. */
export async function closeSetupResources(options: {
  readonly mcpToolPort?: McpToolPort | undefined;
  readonly sandboxBackend?: SandboxBackend | undefined;
  readonly eventStore: EventStore | undefined;
  readonly vault: RuntimeVault | undefined;
  readonly instanceHeartbeat: RuntimeComposition["instanceHeartbeat"];
  readonly rateLimitStore?: RateLimitStore | undefined;
  readonly disposeKeys: () => void;
}): Promise<void> {
  const cleanup: (() => Promise<void>)[] = [
    () => Promise.resolve().then(() => options.mcpToolPort?.close()),
    () => Promise.resolve().then(() => options.sandboxBackend?.close?.()),
    () => Promise.resolve().then(() => options.eventStore?.close()),
    () => Promise.resolve().then(() => options.vault?.close()),
    () => Promise.resolve().then(() => options.rateLimitStore?.close?.()),
    () => Promise.resolve().then(() => options.instanceHeartbeat?.close()),
    () => Promise.resolve().then(options.disposeKeys),
  ];
  let firstError: unknown;
  for (const action of cleanup) {
    try {
      await action();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError instanceof Error) {
    throw firstError;
  }
  if (firstError !== undefined) {
    throw new Error("Runtime cleanup failed.", { cause: firstError });
  }
}
