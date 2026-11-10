// SPDX-License-Identifier: Apache-2.0
import { createRuntime } from "@rovinos/core";
import { loadConfig, type HarnessConfig } from "@rovinos/config";
import { createHarnessClient } from "./harness.js";
import { ExtensionError, prepareExtensions } from "./extensions.js";
import type { ExtensionRegistration } from "./extensions.js";
import { runtimeOverridesFrom } from "./runtime-overrides.js";
import {
  CreateHarnessOptionsSchema,
  HarnessOverridesSchema,
  type CreateHarnessOptions,
  type Harness,
} from "./types.js";
import type { ZodError } from "zod";

type HarnessIssue = ZodError["issues"][number];

function findExtensionIssue(issues: readonly HarnessIssue[]): HarnessIssue | undefined {
  for (const issue of issues) {
    if (issue.path[0] === "extensions") {
      return issue;
    }
    if (issue.code === "invalid_union") {
      const nestedIssue = findExtensionIssue(issue.errors.flat());
      if (nestedIssue !== undefined) {
        return nestedIssue;
      }
    }
  }
  return undefined;
}

/**
 * Creates a validated public SDK around the internal runtime.
 *
 * @param options - Validated config object or config path, optional adapters, extensions and content authorizer.
 * @returns Programmatic run, metadata, approval, and subscription operations.
 */
export async function createHarness<
  const Registrations extends readonly ExtensionRegistration[] = readonly ExtensionRegistration[],
>(options: CreateHarnessOptions<Registrations>): Promise<Harness> {
  const parsedOptionsResult = CreateHarnessOptionsSchema.safeParse(options);
  if (!parsedOptionsResult.success) {
    const extensionIssue = findExtensionIssue(parsedOptionsResult.error.issues);
    if (extensionIssue !== undefined) {
      let code:
        | "extension_config_invalid"
        | "extension_grant_invalid"
        | "extension_manifest_invalid"
        | "extension_contribution_invalid" = "extension_contribution_invalid";
      if (
        extensionIssue.path.some(
          (segment) => typeof segment === "string" && segment.startsWith("config"),
        )
      ) {
        code = "extension_config_invalid";
      } else if (extensionIssue.path.includes("grants")) {
        code = "extension_grant_invalid";
      } else if (extensionIssue.path.includes("manifest")) {
        code = "extension_manifest_invalid";
      }
      throw new ExtensionError(code);
    }
    throw parsedOptionsResult.error;
  }
  const parsedOptions = parsedOptionsResult.data;
  const baseOverrides = HarnessOverridesSchema.parse(parsedOptions.overrides ?? {});
  const config: HarnessConfig =
    "config" in parsedOptions
      ? parsedOptions.config
      : await loadConfig({ configPath: parsedOptions.configPath });
  const preparedExtensions =
    parsedOptions.extensions === undefined
      ? undefined
      : prepareExtensions(
          parsedOptions.extensions,
          baseOverrides.tool,
          baseOverrides.providerAdapters ?? [],
          config.run.budgets.maxWallClockMs,
        );
  const runtimeOverrides = runtimeOverridesFrom(
    preparedExtensions === undefined
      ? baseOverrides
      : {
          ...baseOverrides,
          ...(preparedExtensions.tool === undefined ? {} : { tool: preparedExtensions.tool }),
          providerAdapters: [...preparedExtensions.providers],
        },
  );
  const runtime = await createRuntime(config, runtimeOverrides);
  return createHarnessClient({
    runtime,
    piiEnabled: config.pii.enabled,
    correlationEnabled: config.telemetry.correlation.enabled,
    shutdownGraceMs: config.run.shutdownGraceMs,
    contentAuthorizer: parsedOptions.contentAuthorizer,
    readExtensionStatus: () => preparedExtensions?.getStatuses() ?? [],
    revokeGrant: (request) => preparedExtensions?.revokeGrant(request) ?? false,
  });
}
