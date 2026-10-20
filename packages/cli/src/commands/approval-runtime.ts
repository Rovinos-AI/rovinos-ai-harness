// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from "@harness/config";
import type { Runtime } from "@harness/core";
import type { RunQueue } from "@harness/store";
import type { CliContext } from "../command.js";
import { createCommandRuntime } from "../command.js";

export interface ApprovalRuntimeOptions {
  readonly config?: HarnessConfig;
  readonly disableAutoResume?: boolean;
  readonly useQueue?: boolean;
}

export async function withApprovalRuntime<T>(
  context: CliContext,
  overrides: Parameters<typeof createCommandRuntime>[2],
  action: (runtime: Runtime, config: HarnessConfig) => Promise<T>,
  options: ApprovalRuntimeOptions = {},
): Promise<T> {
  const runtimeConfig = options.config ?? (await context.loadConfig());
  const queue = options.useQueue === true ? await openQueue(context, runtimeConfig) : undefined;
  const configuredRuntime =
    options.disableAutoResume === true && runtimeConfig.run.autoResume
      ? { ...runtimeConfig, run: { ...runtimeConfig.run, autoResume: false } }
      : runtimeConfig;
  let runtime: Runtime;
  try {
    runtime = await createCommandRuntime(context, configuredRuntime, {
      ...overrides,
      ...(queue === undefined ? {} : { queue }),
    });
  } catch (error) {
    await queue?.close();
    throw error;
  }
  try {
    return await action(runtime, runtimeConfig);
  } finally {
    try {
      await runtime.close();
    } finally {
      await queue?.close();
    }
  }
}

async function openQueue(context: CliContext, config: HarnessConfig): Promise<RunQueue> {
  if (context.openRunQueue !== undefined) {
    return context.openRunQueue(config);
  }
  const { openConfiguredRunQueue } = await import("@harness/core");
  return openConfiguredRunQueue(config, {
    clock: context.clock,
    ...(context.dataDir === undefined ? {} : { dataDir: context.dataDir }),
    ...(context.secretResolver === undefined
      ? {}
      : { secretResolver: context.secretResolver }),
  });
}
