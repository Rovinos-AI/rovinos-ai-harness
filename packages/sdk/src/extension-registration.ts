// SPDX-License-Identifier: Apache-2.0
import { Code, JsonValue as JsonValueSchema, type JsonValue } from "@rovinos/schemas";
import type { ProviderAdapter } from "@rovinos/models";
import { z } from "zod";
import { isBoundedJsonValue } from "./extension-json.js";
import {
  ExtensionError, ExtensionManifestSchema, ExtensionRegistrationStatusSchema,
} from "./extension-contracts.js";
import type {
  ExtensionCapabilityStatus,
  ExtensionContributions,
  ExtensionGrant,
  ExtensionManifest,
  ExtensionRegistration,
  ExtensionRegistrationStatus,
  ExtensionToolDefinition,
} from "./extension-contracts.js";
import {
  capabilityTargets,
  grantTarget,
  isRecord,
  isSupportedSdkRange,
  makeCapabilityStatus,
  supportsCapability,
} from "./extension-runtime-helpers.js";
import {
  DEFAULT_EXTENSION_OUTPUT_BYTES,
  DEFAULT_EXTENSION_TOOL_TIMEOUT_MS,
  MAX_CAPABILITY_TARGETS,
  MAX_EXTENSION_JSON_BYTES,
  MAX_EXTENSION_TOOL_TIMEOUT_MS,
} from "./extension-constants.js";
import type { RegisteredTool } from "./extension-tool-port.js";

/** Validates declared capabilities against the operator's active destination grants. */
export function validateGrants(
  manifest: ExtensionManifest,
  grants: readonly ExtensionGrant[],
  namespace: string,
  activeGrants: Map<string, Set<string>>,
): readonly ExtensionCapabilityStatus[] {
  const allCapabilities = [...manifest.capabilities.required, ...manifest.capabilities.optional];
  if (new Set(grants.map(({ kind }) => kind)).size !== grants.length) {
    throw new ExtensionError("extension_grant_invalid");
  }
  for (const grant of grants) {
    const declaration = allCapabilities.find((capability) => capability.kind === grant.kind);
    if (
      declaration === undefined ||
      capabilityTargets(grant).some((target) => !capabilityTargets(declaration).includes(target))
    ) {
      throw new ExtensionError("extension_grant_invalid");
    }
  }

  const activeTargets = new Set<string>();
  const namespaceGrants = activeGrants.get(namespace) ?? activeTargets;
  for (const grant of grants) {
    for (const target of capabilityTargets(grant)) {
      namespaceGrants.add(grantTarget(grant.kind, target));
      activeTargets.add(grantTarget(grant.kind, target));
    }
  }
  activeGrants.set(namespace, namespaceGrants);
  const statuses = allCapabilities.map((capability) => makeCapabilityStatus(capability, activeTargets));
  for (const [index, capability] of manifest.capabilities.required.entries()) {
    if (!supportsCapability(capability)) {
      throw new ExtensionError("extension_capability_unsupported");
    }
    const status = statuses[index];
    if (status === undefined || status.unsupported.length > 0) {
      throw new ExtensionError("extension_grant_missing");
    }
  }
  return statuses;
}

/** Checks the minimal provider adapter surface before registration. */
export function validateProviderAdapter(value: unknown): value is ProviderAdapter {
  return (
    isRecord(value) &&
    Code.safeParse(value.provider).success &&
    [
      "anthropic",
      "azure_openai",
      "bedrock",
      "openai",
      "openai_compatible",
      "vertex",
      "cassette",
    ].includes(String(value.kind)) &&
    typeof value.complete === "function"
  );
}

function asToolDefinition(value: unknown): value is ExtensionToolDefinition {
  return (
    isRecord(value) &&
    Code.safeParse(value.name).success &&
    typeof value.description === "string" &&
    value.description.length > 0 &&
    value.description.length <= 512 &&
    value.inputSchema instanceof z.ZodType &&
    value.outputSchema instanceof z.ZodType &&
    typeof value.execute === "function"
  );
}

/** Validates and registers one extension directly through the SDK runtime. */
export function registerOne(
  registration: ExtensionRegistration,
  state: ExtensionRegistrationState,
): ExtensionRegistrationStatus {
  const context = validateRegistration(registration, state);
  const capabilities = validateGrants(
    context.manifest,
    registration.grants,
    registration.namespace,
    state.activeGrants,
  );
  const config = parseExtensionConfig(registration);
  const contributions = createExtensionContributions(context.definition, config, capabilities);
  registerContributions({ ...context, capabilities, state }, contributions);
  return ExtensionRegistrationStatusSchema.parse({
    namespace: registration.namespace,
    id: context.manifest.id,
    version: context.manifest.version,
    capabilities,
  });
}

/** Mutable registration indexes, scoped to one SDK harness construction. */
export interface ExtensionRegistrationState {
  readonly namespaces: Set<string>;
  readonly identities: Set<string>;
  readonly tools: Map<string, RegisteredTool>;
  readonly providers: Map<string, ProviderAdapter>;
  readonly activeGrants: Map<string, Set<string>>;
}

interface ValidatedRegistration {
  readonly registration: ExtensionRegistration;
  readonly namespace: string;
  readonly definition: ExtensionRegistration["definition"];
  readonly manifest: ExtensionManifest;
}

interface EnabledRegistration extends ValidatedRegistration {
  readonly registration: ExtensionRegistration;
  readonly capabilities: readonly ExtensionCapabilityStatus[];
  readonly state: ExtensionRegistrationState;
}

function validateRegistration(
  registration: ExtensionRegistration,
  state: ExtensionRegistrationState,
): ValidatedRegistration {
  const { namespace, definition } = registration;
  if (state.namespaces.has(namespace)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  state.namespaces.add(namespace);

  const manifestResult = ExtensionManifestSchema.safeParse(definition.manifest);
  if (!manifestResult.success) {
    throw new ExtensionError("extension_manifest_invalid");
  }
  const manifest = manifestResult.data;
  if (state.identities.has(manifest.id)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  state.identities.add(manifest.id);
  if (!isSupportedSdkRange(manifest.sdkRange)) {
    throw new ExtensionError("extension_incompatible");
  }
  return { registration, namespace, definition, manifest };
}

function parseExtensionConfig(registration: ExtensionRegistration): unknown {
  const { definition } = registration;
  let configResult: ReturnType<typeof definition.configSchema.safeParse>;
  try {
    configResult = definition.configSchema.safeParse(registration.config);
  } catch {
    throw new ExtensionError("extension_config_invalid");
  }
  if (
    !configResult.success ||
    (configResult.data !== undefined && !isBoundedJsonValue(configResult.data))
  ) {
    throw new ExtensionError("extension_config_invalid");
  }

  return configResult.data;
}

function createExtensionContributions(
  definition: ExtensionRegistration["definition"],
  config: unknown,
  capabilities: readonly ExtensionCapabilityStatus[],
): ExtensionContributions {
  if (!capabilities.some((status) => status.enabled.length > 0)) {
    return {};
  }
  let contributions: unknown;
  try {
    contributions = definition.createContributions(config);
  } catch {
    throw new ExtensionError("extension_contribution_invalid");
  }
  if (!isExtensionContributions(contributions)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  return contributions;
}

function isExtensionContributions(value: unknown): value is ExtensionContributions {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "tools" && key !== "providers")
  ) {
    return false;
  }
  const toolsValid = value.tools === undefined ||
    (Array.isArray(value.tools) && value.tools.every(asToolDefinition));
  const providersValid = value.providers === undefined ||
    (Array.isArray(value.providers) && value.providers.every(validateProviderAdapter));
  return toolsValid && providersValid;
}

function registerContributions(
  context: EnabledRegistration,
  contributions: ExtensionContributions,
): void {
  const providedTools = contributions.tools ?? [];
  const providedProviders = contributions.providers ?? [];
  if (
    providedTools.length > MAX_CAPABILITY_TARGETS ||
    providedProviders.length > MAX_CAPABILITY_TARGETS
  ) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  const registeredToolNames = registerTools(context, providedTools);
  const registeredProviders = registerProviders(context, providedProviders);
  const enabledTools = enabledTargets(context.capabilities, "tools.contribute");
  const enabledProviders = enabledTargets(context.capabilities, "providers.contribute");
  if (
    [...enabledTools].some((name) => !registeredToolNames.has(name)) ||
    [...enabledProviders].some((provider) => !registeredProviders.has(provider))
  ) {
    throw new ExtensionError("extension_contribution_invalid");
  }
}

function declaredTargets(
  manifest: ExtensionManifest,
  kind: "tools.contribute" | "providers.contribute",
): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const capability of [
    ...manifest.capabilities.required,
    ...manifest.capabilities.optional,
  ]) {
    if (kind === "tools.contribute" && capability.kind === "tools.contribute") {
      capability.names.forEach((name) => targets.add(name));
    }
    if (kind === "providers.contribute" && capability.kind === "providers.contribute") {
      capability.providers.forEach((provider) => targets.add(provider));
    }
  }
  return targets;
}

function enabledTargets(
  capabilities: readonly ExtensionCapabilityStatus[],
  kind: "tools.contribute" | "providers.contribute",
): ReadonlySet<string> {
  return new Set(capabilities.find((capability) => capability.kind === kind)?.enabled ?? []);
}

function registerTools(
  context: EnabledRegistration,
  candidates: readonly ExtensionToolDefinition[],
): ReadonlySet<string> {
  const declared = declaredTargets(context.manifest, "tools.contribute");
  const enabled = enabledTargets(context.capabilities, "tools.contribute");
  const registered = new Set<string>();
  for (const candidate of candidates) {
    if (!asToolDefinition(candidate) || !declared.has(candidate.name)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    if (!enabled.has(candidate.name)) {
      continue;
    }
    registerTool(context, candidate);
    registered.add(candidate.name);
  }
  return registered;
}

function registerTool(
  context: EnabledRegistration,
  candidate: ExtensionToolDefinition,
): void {
  const toolIdValue = `${context.namespace}.${candidate.name}`;
  const toolId = Code.safeParse(toolIdValue);
  if (!toolId.success || context.state.tools.has(toolIdValue)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  const inputJsonSchema = toolInputJsonSchema(candidate);
  context.state.tools.set(toolIdValue, {
    toolId: toolId.data,
    name: candidate.name,
    inputSchema: candidate.inputSchema,
    outputSchema: candidate.outputSchema,
    inputJsonSchema,
    description: candidate.description,
    timeoutMs: Math.min(
      context.registration.toolTimeoutMs ?? DEFAULT_EXTENSION_TOOL_TIMEOUT_MS,
      MAX_EXTENSION_TOOL_TIMEOUT_MS,
    ),
    maxOutputBytes: Math.min(
      context.registration.maxOutputBytes ?? DEFAULT_EXTENSION_OUTPUT_BYTES,
      MAX_EXTENSION_JSON_BYTES,
    ),
    extensionVersion: context.manifest.version,
    execute: (input, toolContext) => candidate.execute(input, toolContext),
    isGranted: () =>
      context.state.activeGrants
        .get(context.namespace)
        ?.has(grantTarget("tools.contribute", candidate.name)) === true,
  });
}

function toolInputJsonSchema(candidate: ExtensionToolDefinition): JsonValue {
  try {
    const generatedSchema = z.toJSONSchema(candidate.inputSchema, { unrepresentable: "throw" });
    if (!isBoundedJsonValue(generatedSchema, true)) {
      throw new ExtensionError("extension_schema_unsupported");
    }
    return JsonValueSchema.parse(generatedSchema);
  } catch {
    throw new ExtensionError("extension_schema_unsupported");
  }
}

function registerProviders(
  context: EnabledRegistration,
  candidates: readonly ProviderAdapter[],
): ReadonlySet<string> {
  const declared = declaredTargets(context.manifest, "providers.contribute");
  const enabled = enabledTargets(context.capabilities, "providers.contribute");
  const registered = new Set<string>();
  for (const candidate of candidates) {
    if (!validateProviderAdapter(candidate) || !declared.has(candidate.provider)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    if (!enabled.has(candidate.provider)) {
      continue;
    }
    registerProvider(context, candidate);
    registered.add(candidate.provider);
  }
  return registered;
}

function registerProvider(context: EnabledRegistration, candidate: ProviderAdapter): void {
  if (context.state.providers.has(candidate.provider)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  const isActive = () =>
    context.state.activeGrants
      .get(context.namespace)
      ?.has(grantTarget("providers.contribute", candidate.provider)) === true;
  context.state.providers.set(candidate.provider, {
    ...candidate,
    complete(request, providerContext) {
      if (!isActive()) {
        throw new ExtensionError("extension_grant_missing");
      }
      return candidate.complete(request, providerContext);
    },
    ...(candidate.stream === undefined
      ? {}
      : {
          async *stream(request, providerContext) {
            if (!isActive()) {
              throw new ExtensionError("extension_grant_missing");
            }
            for await (const delta of candidate.stream?.(request, providerContext) ?? []) {
              if (!isActive()) {
                throw new ExtensionError("extension_grant_missing");
              }
              yield delta;
            }
          },
        }),
  });
}
