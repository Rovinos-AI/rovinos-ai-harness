// SPDX-License-Identifier: Apache-2.0
// 19.3: Remote runner configuration is owned by @harness/sandbox.
import { z } from "zod";
import { SecretRefSchema } from "../secret-ref.js";

/** HTTP origin used for internal communication with the sandbox runner. */
export const SandboxRunnerUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === "/"
  );
});

const SandboxRunnerConfigSchema = z
  .object({
    url: SandboxRunnerUrlSchema,
    token: SecretRefSchema,
  })
  .strict();

/** Sandbox-specific options with unsafe local execution disabled by default. */
export const SandboxConfigSchema = z
  .object({
    allowUnsafeInProcess: z.boolean().optional(),
    runner: SandboxRunnerConfigSchema.optional(),
  })
  .strict()
  .prefault({});
