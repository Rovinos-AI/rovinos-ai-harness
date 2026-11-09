// SPDX-License-Identifier: Apache-2.0
import type { ToolPort } from "@rovinos/core";
import type { ProviderAdapter } from "@rovinos/models";
import {
  ExtensionError, ExtensionManifestSchema, ExtensionRegistrationStatusSchema,
} from "./extension-contracts.js";
import type {
  ExtensionGrantRevocation,
  ExtensionManifest,
  ExtensionRegistration,
} from "./extension-contracts.js";
import {
  DEFAULT_EXTENSION_TOOL_TIMEOUT_MS,
  MAX_EXTENSION_COUNT,
} from "./extension-constants.js";
import { makeCapabilityStatus, grantTarget } from "./extension-runtime-helpers.js";
import {
  validateProviderAdapter,
  registerOne,
} from "./extension-registration.js";
import type { ExtensionRegistrationState } from "./extension-registration.js";
import { makeExtensionToolPort, composeToolPorts } from "./extension-tool-port.js";
import type { PreparedExtensions } from "./extension-runtime-types.js";
import type { RegisteredTool } from "./extension-tool-port.js";

/** Validates direct registrations and prepares ports for the existing governed runtime. */
export function prepareExtensions(
  registrations: readonly ExtensionRegistration[],
  baseTool: ToolPort | undefined,
  baseProviders: readonly ProviderAdapter[],
  maxWallClockMs = 3_600_000,
): PreparedExtensions {
  if (registrations.length > MAX_EXTENSION_COUNT) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  const state: ExtensionRegistrationState = {
    namespaces: new Set<string>(),
    identities: new Set<string>(),
    tools: new Map<string, RegisteredTool>(),
    providers: new Map<string, ProviderAdapter>(),
    activeGrants: new Map<string, Set<string>>(),
  };
  const records: {
    readonly namespace: string;
    readonly manifest: ExtensionManifest;
  }[] = [];
  for (const provider of baseProviders) {
    if (!validateProviderAdapter(provider) || state.providers.has(provider.provider)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    state.providers.set(provider.provider, provider);
  }
  for (const registration of registrations) {
    const boundedRegistration = {
      ...registration,
      toolTimeoutMs: Math.min(
        registration.toolTimeoutMs ?? DEFAULT_EXTENSION_TOOL_TIMEOUT_MS,
        maxWallClockMs,
      ),
    };
    registerOne(boundedRegistration, state);
    records.push({
      namespace: registration.namespace,
      manifest: ExtensionManifestSchema.parse(registration.definition.manifest),
    });
  }
  const extensionToolPort = makeExtensionToolPort(state.tools);
  const getStatuses = () =>
    records.map(({ namespace, manifest }) =>
      ExtensionRegistrationStatusSchema.parse({
        namespace,
        id: manifest.id,
        version: manifest.version,
        capabilities: [...manifest.capabilities.required, ...manifest.capabilities.optional].map(
          (capability) =>
            makeCapabilityStatus(
              capability,
              state.activeGrants.get(namespace) ?? new Set<string>(),
            ),
        ),
      }),
    );
  const revokeGrant = ({ namespace, kind, target }: ExtensionGrantRevocation) => {
    const grants = state.activeGrants.get(namespace);
    if (grants === undefined) {
      return false;
    }
    return grants.delete(grantTarget(kind, target));
  };
  let tool: ToolPort | undefined;
  if (extensionToolPort === undefined) {
    tool = baseTool;
  } else {
    tool = composeToolPorts(baseTool, extensionToolPort);
  }
  return {
    ...(tool === undefined ? {} : { tool }),
    providers: [...state.providers.values()],
    getStatuses,
    revokeGrant,
  };
}
