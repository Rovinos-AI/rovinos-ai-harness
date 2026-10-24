// SPDX-License-Identifier: Apache-2.0
// 19.11: Compose owns the runner's egress topology; never emulate it on the host.
import { SandboxConfigSchema, type SecretRef } from "@rovinos/schemas";
import type { z } from "zod";
import { InProcessBackend, type InProcessBackendOptions } from "./inprocess.js";
import { RemoteSandboxBackend, RemoteSandboxError } from "./remote.js";
import type { SandboxBackend } from "./types.js";

/** Host dependencies shared by configured sandbox backends. */
export interface SandboxBackendDependencies {
  readonly workspaceRoot: string;
  readonly logger: InProcessBackendOptions["logger"];
  readonly clock?: InProcessBackendOptions["clock"];
  readonly secretResolver?: {
    resolve(ref: SecretRef): Promise<{ reveal(): string }>;
  };
}

/**
 * Selects the remote runner or the development-only local backend.
 *
 * @param config - Sandbox configuration, defaulting to the local backend.
 * @param deps - Workspace, safe logger, clock, and runner secret resolver.
 * @returns One backend owned by the runtime.
 */
export async function createSandboxBackend(
  config: z.infer<typeof SandboxConfigSchema> | undefined,
  deps: SandboxBackendDependencies,
): Promise<SandboxBackend> {
  const parsed = SandboxConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    throw new RemoteSandboxError("sandbox_runner_config_invalid");
  }
  const sandbox = parsed.data;
  if (sandbox.runner !== undefined) {
    try {
      if (deps.secretResolver === undefined) {
        throw new RemoteSandboxError("sandbox_runner_config_invalid");
      }
      const token = await deps.secretResolver.resolve(sandbox.runner.token);
      return new RemoteSandboxBackend({ url: sandbox.runner.url, token: token.reveal() });
    } catch {
      throw new RemoteSandboxError("sandbox_runner_config_invalid");
    }
  }
  if ((sandbox.egress?.allow.length ?? 0) > 0) {
    throw new RemoteSandboxError("sandbox_runner_config_invalid");
  }
  return new InProcessBackend({
    workspaceRoot: deps.workspaceRoot,
    logger: deps.logger,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(sandbox.allowUnsafeInProcess === undefined
      ? {}
      : { allowUnsafeInProcess: sandbox.allowUnsafeInProcess }),
  });
}
