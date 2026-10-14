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

/** Exact host and port pairs that the sandbox egress proxy may reach. */
export const SandboxEgressAllowEntrySchema = z
  .object({
    host: z.string().min(1).max(253).refine((host) => host.trim() === host && !host.includes("*")),
    ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(128),
  })
  .strict();

/** Bounded list of exact egress destinations shared by config and the proxy process. */
export const SandboxEgressAllowlistSchema = z.array(SandboxEgressAllowEntrySchema).max(128);

/** Optional allowlist for runner egress through the enforcing proxy. */
export const SandboxEgressConfigSchema = z
  .object({
    allow: SandboxEgressAllowlistSchema,
  })
  .strict();

/** Sandbox-specific options with unsafe local execution disabled by default. */
export const SandboxConfigSchema = z
  .object({
    allowUnsafeInProcess: z.boolean().optional(),
    egress: SandboxEgressConfigSchema.optional(),
    runner: SandboxRunnerConfigSchema.optional(),
  })
  .strict()
  .prefault({});
