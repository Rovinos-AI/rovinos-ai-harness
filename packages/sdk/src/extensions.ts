// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { HarnessError, Code, JsonValue as JsonValueSchema } from "@rovinos/schemas";
import { Sha256Hex } from "@rovinos/schemas";
import type { JsonValue, Sha256Hex as Sha256HexType, ToolSpec } from "@rovinos/schemas";
import type { ModelToolCall, ToolDescription, ToolExecutionResult, ToolPort } from "@rovinos/core";
import type { ProviderAdapter } from "@rovinos/models";
import { z } from "zod";

/** Current SDK compatibility version used when validating extension manifests. */
export const SDK_VERSION = "0.3.0";
const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u;
const MAX_EXTENSION_COUNT = 32;
const MAX_CAPABILITIES = 16;
const MAX_CAPABILITY_TARGETS = 64;
const MAX_EXTENSION_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_EXTENSION_TOOL_TIMEOUT_MS = 30_000;
const MAX_EXTENSION_JSON_BYTES = 64 * 1024;
const DEFAULT_EXTENSION_OUTPUT_BYTES = MAX_EXTENSION_JSON_BYTES;
const MAX_EXTENSION_JSON_DEPTH = 32;
const MAX_EXTENSION_JSON_NODES = 4_096;
const utf8Encoder = new TextEncoder();

function verifyBoundedJsonValue(
  value: unknown,
  allowZodMetadata = false,
  maxBytes = MAX_EXTENSION_JSON_BYTES,
): value is JsonValue {
  const ancestors = new WeakSet<object>();
  const stack: { readonly value: unknown; readonly depth: number; readonly exit?: object }[] = [
    { value, depth: 0 },
  ];
  let bytes = 0;
  let nodes = 0;
  const addBytes = (text: string): boolean => {
    bytes += utf8Encoder.encode(text).byteLength;
    return bytes <= maxBytes;
  };

  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) {
      return false;
    }
    if (item.exit !== undefined) {
      ancestors.delete(item.exit);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_EXTENSION_JSON_NODES || item.depth > MAX_EXTENSION_JSON_DEPTH) {
      return false;
    }
    const current = item.value;
    if (current === null) {
      if (!addBytes("null")) {
        return false;
      }
      continue;
    }
    if (typeof current === "boolean" || (typeof current === "number" && Number.isFinite(current))) {
      if (!addBytes(JSON.stringify(current) ?? "")) {
        return false;
      }
      continue;
    }
    if (typeof current === "string") {
      if (!addBytes(JSON.stringify(current) ?? "")) {
        return false;
      }
      continue;
    }
    if (typeof current !== "object" || ancestors.has(current)) {
      return false;
    }
    ancestors.add(current);
    stack.push({ value: undefined, depth: item.depth, exit: current });
    if (Array.isArray(current)) {
      if (!addBytes(`[${",".repeat(Math.max(0, current.length - 1))}]`)) {
        return false;
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        return false;
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== current.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        return false;
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          return false;
        }
        stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    if (Object.getOwnPropertySymbols(current).length > 0) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const ownKeys = Object.keys(descriptors);
    if (
      ownKeys.some(
        (key) =>
          descriptors[key]?.enumerable !== true &&
          !(allowZodMetadata && key === "~standard"),
      )
    ) {
      return false;
    }
    const keys = ownKeys.filter((key) => descriptors[key]?.enumerable === true);
    if (!addBytes(`{${",".repeat(Math.max(0, keys.length - 1))}}`)) {
      return false;
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        !addBytes(`${JSON.stringify(key) ?? ""}:`)
      ) {
        return false;
      }
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  return true;
}

function isBoundedJsonValue(
  value: unknown,
  allowZodMetadata = false,
  maxBytes = MAX_EXTENSION_JSON_BYTES,
): value is JsonValue {
  try {
    return verifyBoundedJsonValue(value, allowZodMetadata, maxBytes);
  } catch {
    return false;
  }
}

const BoundedJsonValueSchema = z.custom<JsonValue>(isBoundedJsonValue);

const SafeEventKindSchema = z.enum([
  "model_call",
  "tool_call",
  "policy_decision",
  "approval_wait",
  "input_wait",
  "checkpoint",
  "run_status",
  "pii_action",
  "budget_exceeded",
  "subagent_spawned",
  "subagent_completed",
  "run_created",
]);

const CapabilityTargets = z.array(Code).min(1).max(MAX_CAPABILITY_TARGETS).refine(
  (targets) => new Set(targets).size === targets.length,
  "Capability targets must be unique.",
);

/** Closed capability requests. These declarations describe needs; they never grant access. */
export const ExtensionCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tools.contribute"), names: CapabilityTargets }).strict(),
  z.object({ kind: z.literal("providers.contribute"), providers: CapabilityTargets }).strict(),
  z.object({ kind: z.literal("events.observe"), kinds: z.array(SafeEventKindSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("content.read"), bindings: CapabilityTargets }).strict(),
]);

/** Inferred extension capability request. */
export type ExtensionCapability = z.infer<typeof ExtensionCapabilitySchema>;

const CapabilityListSchema = z.array(ExtensionCapabilitySchema).max(MAX_CAPABILITIES).refine(
  (capabilities) => {
    const seen = new Set<string>();
    for (const capability of capabilities) {
      if (seen.has(capability.kind)) {
        return false;
      }
      seen.add(capability.kind);
    }
    return true;
  },
  "Capability declarations must be unique.",
);

/** Serialized manifest data. It contains no executable expressions or module paths. */
export const ExtensionManifestSchema = z
  .object({
    id: Code,
    version: z.string().regex(VERSION_PATTERN),
    sdkRange: z.string().min(1).max(128).refine(isValidSdkRangeSyntax),
    schemaVersion: z.literal(1),
    capabilities: z
      .object({
        required: CapabilityListSchema,
        optional: CapabilityListSchema,
      })
      .strict()
      .superRefine((capabilities, context) => {
        const required = new Set(capabilities.required.map(({ kind }) => kind));
        for (const [index, capability] of capabilities.optional.entries()) {
          if (required.has(capability.kind)) {
            context.addIssue({
              code: "custom",
              path: ["optional", index],
              message: "A capability cannot be both required and optional.",
            });
          }
        }
      }),
  })
  .strict();

/** Inferred extension manifest. */
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

/** Operator grant matching a declared capability and its explicit destination names. */
export const ExtensionGrantSchema = ExtensionCapabilitySchema;

/** Inferred operator-approved extension grant. */
export type ExtensionGrant = z.infer<typeof ExtensionGrantSchema>;

/** Narrow context passed to a registered tool during a core-governed invocation. */
export interface ToolInvocationContext {
  /** Cooperative cancellation signal for the active tool invocation. */
  readonly signal: AbortSignal;
}

/** Typed tool contribution whose input and output contracts are runtime validated. */
export interface ExtensionToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  /** Core controls policy, approval, cancellation, privacy and budgets around this callback. */
  execute(
    input: z.output<InputSchema>,
    context: ToolInvocationContext,
  ): Promise<z.output<OutputSchema>>;
}

/** Create a tool definition with input and output types inferred from its Zod schemas. */
export function defineTool<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
>(
  definition: ExtensionToolDefinition<InputSchema, OutputSchema>,
): ExtensionToolDefinition<InputSchema, OutputSchema> {
  return definition;
}

/** Contributions created after the SDK validates a manifest, configuration and operator grants. */
export interface ExtensionContributions {
  readonly tools?: readonly ExtensionToolDefinition[];
  readonly providers?: readonly ProviderAdapter[];
}

/** SDK-owned extension definition. Its callback is trusted in-process application code. */
export interface ExtensionDefinition<ConfigSchema extends z.ZodType = z.ZodType> {
  readonly manifest: ExtensionManifest;
  readonly configSchema: ConfigSchema;
  readonly createContributions: (
    config: z.output<ConfigSchema>,
  ) => ExtensionContributions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime guard for direct SDK registration; authoring helpers are not required. */
export const ExtensionDefinitionSchema = z
  .object({
    manifest: ExtensionManifestSchema,
    configSchema: z.custom<z.ZodType>((value) => value instanceof z.ZodType),
    createContributions: z.custom<ExtensionDefinition["createContributions"]>(
      (value) => typeof value === "function",
    ),
  })
  .strict();

/** Direct registration request accepted by {@link createHarness}. */
export const ExtensionRegistrationSchema = z
  .object({
    namespace: Code,
    definition: ExtensionDefinitionSchema,
    config: BoundedJsonValueSchema.optional(),
    grants: z.array(ExtensionGrantSchema).max(MAX_CAPABILITIES),
    toolTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_EXTENSION_TOOL_TIMEOUT_MS)
      .default(DEFAULT_EXTENSION_TOOL_TIMEOUT_MS),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_EXTENSION_JSON_BYTES)
      .default(DEFAULT_EXTENSION_OUTPUT_BYTES),
  })
  .strict()
  .superRefine((registration, context) => {
    if (new Set(registration.grants.map(({ kind }) => kind)).size !== registration.grants.length) {
      context.addIssue({
        code: "custom",
        path: ["grants"],
        message: "Only one grant per capability kind is supported.",
      });
    }
  });

/** Inferred direct extension registration request. */
export type ExtensionRegistration<
  Definition extends ExtensionDefinition = ExtensionDefinition,
> = Omit<z.input<typeof ExtensionRegistrationSchema>, "definition" | "config"> & {
  readonly definition: Definition;
  readonly config?: (z.input<Definition["configSchema"]> & JsonValue) | undefined;
};

/** Metadata describing which requested capabilities are enabled or explicitly unsupported. */
export const ExtensionCapabilityStatusSchema = z
  .object({
    kind: z.enum([
      "tools.contribute",
      "providers.contribute",
      "events.observe",
      "content.read",
    ]),
    requested: z.array(Code),
    enabled: z.array(Code),
    unsupported: z.array(Code),
    reason: z.enum(["not_granted", "not_implemented"]).optional(),
  })
  .strict();

/** Inferred capability status returned by the harness. */
export type ExtensionCapabilityStatus = z.infer<typeof ExtensionCapabilityStatusSchema>;

/** Non-sensitive registration status; it contains no configuration or extension code. */
export const ExtensionRegistrationStatusSchema = z
  .object({
    namespace: Code,
    id: Code,
    version: z.string().regex(VERSION_PATTERN),
    capabilities: z.array(ExtensionCapabilityStatusSchema),
  })
  .strict();

/** Inferred extension registration status. */
export type ExtensionRegistrationStatus = z.infer<typeof ExtensionRegistrationStatusSchema>;

/** Narrow request used by the operator to revoke one extension destination grant. */
export const ExtensionGrantRevocationSchema = z
  .object({
    namespace: Code,
    kind: z.enum(["tools.contribute", "providers.contribute"]),
    target: Code,
  })
  .strict();

/** Inferred extension grant revocation request. */
export type ExtensionGrantRevocation = z.infer<typeof ExtensionGrantRevocationSchema>;

const errorCodes = [
  "extension_manifest_invalid",
  "extension_incompatible",
  "extension_config_invalid",
  "extension_grant_missing",
  "extension_grant_invalid",
  "extension_capability_unsupported",
  "extension_contribution_invalid",
  "extension_schema_unsupported",
  "extension_input_invalid",
  "extension_result_invalid",
  "extension_execution_failed",
] as const;

/** Typed extension registration and execution failure without untrusted values. */
export class ExtensionError extends HarnessError {
  readonly code: (typeof errorCodes)[number];

  /** Creates a stable extension error that does not include extension-controlled data. */
  constructor(code: (typeof errorCodes)[number]) {
    super(`Extension operation failed (${code}).`);
    this.code = code;
    this.name = "ExtensionError";
  }
}

interface RegisteredTool {
  readonly toolId: ReturnType<typeof Code.parse>;
  readonly name: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly inputJsonSchema: JsonValue;
  readonly description: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly extensionVersion: string;
  isGranted(): boolean;
  readonly execute: ExtensionToolDefinition["execute"];
}

interface PreparedExtensions {
  readonly tool?: ToolPort;
  readonly providers: readonly ProviderAdapter[];
  getStatuses(): readonly ExtensionRegistrationStatus[];
  revokeGrant(request: ExtensionGrantRevocation): boolean;
}

function capabilityTargets(capability: ExtensionCapability): readonly string[] {
  if (capability.kind === "tools.contribute") {
    return capability.names;
  }
  if (capability.kind === "providers.contribute") {
    return capability.providers;
  }
  if (capability.kind === "events.observe") {
    return capability.kinds;
  }
  return capability.bindings;
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function parseVersion(value: string): readonly number[] | undefined {
  if (!VERSION_PATTERN.test(value)) {
    return undefined;
  }
  return value.split(".").map(Number);
}

function isValidSdkRangeSyntax(range: string): boolean {
  const terms = range.split(" ");
  return (
    terms.length > 0 &&
    terms.every((term) => {
      const match = /^(>=|>|<=|<|=)?(\d{1,5}\.\d{1,5}\.\d{1,5})$/u.exec(term);
      return match !== null && parseVersion(match[2] ?? "") !== undefined;
    })
  );
}

function isSupportedSdkRange(range: string): boolean {
  if (!isValidSdkRangeSyntax(range)) {
    return false;
  }
  const sdkVersion = parseVersion(SDK_VERSION);
  if (sdkVersion === undefined) {
    return false;
  }
  const terms = range.split(" ");
  for (const term of terms) {
    const match = /^(>=|>|<=|<|=)?(\d{1,5}\.\d{1,5}\.\d{1,5})$/u.exec(term);
    const versionText = match?.[2];
    if (match === null || versionText === undefined) {
      return false;
    }
    const version = parseVersion(versionText);
    if (version === undefined) {
      return false;
    }
    const comparison = compareVersion(sdkVersion, version);
    const operator = match[1] ?? "=";
    const matches =
      operator === ">="
        ? comparison >= 0
        : operator === ">"
          ? comparison > 0
          : operator === "<="
            ? comparison <= 0
            : operator === "<"
              ? comparison < 0
              : comparison === 0;
    if (!matches) {
      return false;
    }
  }
  return true;
}

function supportsCapability(capability: ExtensionCapability): boolean {
  return capability.kind === "tools.contribute" || capability.kind === "providers.contribute";
}

function makeCapabilityStatus(
  capability: ExtensionCapability,
  activeTargets: ReadonlySet<string>,
): ExtensionCapabilityStatus {
  const requested = capabilityTargets(capability);
  if (!supportsCapability(capability)) {
    return {
      kind: capability.kind,
      requested: [...requested],
      enabled: [],
      unsupported: [...requested],
      reason: "not_implemented",
    };
  }
  const enabled = requested.filter((target) =>
    activeTargets.has(grantTarget(capability.kind, target)),
  );
  const unsupported = requested.filter(
    (target) => !activeTargets.has(grantTarget(capability.kind, target)),
  );
  const reason = unsupported.length === 0 ? undefined : "not_granted";
  return {
    kind: capability.kind,
    requested: [...requested],
    enabled: [...enabled],
    unsupported: [...unsupported],
    ...(reason === undefined ? {} : { reason }),
  };
}

function grantTarget(kind: ExtensionCapability["kind"], target: string): string {
  return `${kind}:${target}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: string): Sha256HexType {
  return Sha256Hex.parse(createHash("sha256").update(value).digest("hex"));
}

function validateGrants(
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

function validateProviderAdapter(value: unknown): value is ProviderAdapter {
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

function registerOne(
  registration: ExtensionRegistration,
  namespaces: Set<string>,
  identities: Set<string>,
  tools: Map<string, RegisteredTool>,
  providers: Map<string, ProviderAdapter>,
  activeGrants: Map<string, Set<string>>,
): ExtensionRegistrationStatus {
  const { namespace, definition, grants } = registration;
  if (namespaces.has(namespace)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  namespaces.add(namespace);

  const manifestResult = ExtensionManifestSchema.safeParse(definition.manifest);
  if (!manifestResult.success) {
    throw new ExtensionError("extension_manifest_invalid");
  }
  const manifest = manifestResult.data;
  if (identities.has(manifest.id)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  identities.add(manifest.id);
  if (!isSupportedSdkRange(manifest.sdkRange)) {
    throw new ExtensionError("extension_incompatible");
  }

  const statusByCapability = validateGrants(manifest, grants, namespace, activeGrants);
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

  let contributions: unknown = {};
  if (statusByCapability.some((status) => status.enabled.length > 0)) {
    try {
      contributions = definition.createContributions(configResult.data);
    } catch {
      throw new ExtensionError("extension_contribution_invalid");
    }
  }
  if (!isRecord(contributions)) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  if (Object.keys(contributions).some((key) => key !== "tools" && key !== "providers")) {
    throw new ExtensionError("extension_contribution_invalid");
  }

  const declaredTools = new Set(
    manifest.capabilities.required
      .concat(manifest.capabilities.optional)
      .filter((capability) => capability.kind === "tools.contribute")
      .flatMap((capability) => capability.kind === "tools.contribute" ? capability.names : []),
  );
  const enabledTools = new Set(
    statusByCapability
      .filter((status) => status.kind === "tools.contribute")
      .flatMap((status) => status.enabled),
  );
  const declaredProviders = new Set(
    manifest.capabilities.required
      .concat(manifest.capabilities.optional)
      .filter((capability) => capability.kind === "providers.contribute")
      .flatMap((capability) => capability.kind === "providers.contribute" ? capability.providers : []),
  );
  const enabledProviders = new Set(
    statusByCapability
      .filter((status) => status.kind === "providers.contribute")
      .flatMap((status) => status.enabled),
  );

  const providedTools = contributions.tools ?? [];
  const providedProviders = contributions.providers ?? [];
  if (
    !Array.isArray(providedTools) ||
    providedTools.length > MAX_CAPABILITY_TARGETS ||
    !Array.isArray(providedProviders) ||
    providedProviders.length > MAX_CAPABILITY_TARGETS
  ) {
    throw new ExtensionError("extension_contribution_invalid");
  }
  const registeredToolNames = new Set<string>();
  for (const candidate of providedTools) {
    if (!asToolDefinition(candidate) || !declaredTools.has(candidate.name)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    if (!enabledTools.has(candidate.name)) {
      continue;
    }
    registeredToolNames.add(candidate.name);
    const toolIdValue = `${namespace}.${candidate.name}`;
    const toolId = Code.safeParse(toolIdValue);
    if (!toolId.success || tools.has(toolIdValue)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    let inputJsonSchema: JsonValue;
    try {
      const generatedSchema = z.toJSONSchema(candidate.inputSchema, {
        unrepresentable: "throw",
      });
      if (!isBoundedJsonValue(generatedSchema, true)) {
        throw new ExtensionError("extension_schema_unsupported");
      }
      inputJsonSchema = JsonValueSchema.parse(generatedSchema);
    } catch {
      throw new ExtensionError("extension_schema_unsupported");
    }
    tools.set(toolIdValue, {
      toolId: toolId.data,
      name: candidate.name,
      inputSchema: candidate.inputSchema,
      outputSchema: candidate.outputSchema,
      inputJsonSchema,
      description: candidate.description,
      timeoutMs: Math.min(
        registration.toolTimeoutMs ?? DEFAULT_EXTENSION_TOOL_TIMEOUT_MS,
        MAX_EXTENSION_TOOL_TIMEOUT_MS,
      ),
      maxOutputBytes: Math.min(
        registration.maxOutputBytes ?? DEFAULT_EXTENSION_OUTPUT_BYTES,
        MAX_EXTENSION_JSON_BYTES,
      ),
      extensionVersion: manifest.version,
      execute: candidate.execute,
      isGranted: () =>
        activeGrants.get(namespace)?.has(grantTarget("tools.contribute", candidate.name)) === true,
    });
  }

  const registeredProviders = new Set<string>();
  for (const candidate of providedProviders) {
    if (!validateProviderAdapter(candidate) || !declaredProviders.has(candidate.provider)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    if (!enabledProviders.has(candidate.provider)) {
      continue;
    }
    registeredProviders.add(candidate.provider);
    if (providers.has(candidate.provider)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    const active = () =>
      activeGrants.get(namespace)?.has(grantTarget("providers.contribute", candidate.provider)) ===
      true;
    providers.set(candidate.provider, {
      ...candidate,
      complete: (request, context) => {
        if (!active()) {
          throw new ExtensionError("extension_grant_missing");
        }
        return candidate.complete(request, context);
      },
      ...(candidate.stream === undefined
        ? {}
        : {
            stream: async function* (request, context) {
              if (!active()) {
                throw new ExtensionError("extension_grant_missing");
              }
              for await (const delta of candidate.stream?.(request, context) ?? []) {
                if (!active()) {
                  throw new ExtensionError("extension_grant_missing");
                }
                yield delta;
              }
            },
          }),
    });
  }
  if (
    [...enabledTools].some((name) => !registeredToolNames.has(name)) ||
    [...enabledProviders].some((provider) => !registeredProviders.has(provider))
  ) {
    throw new ExtensionError("extension_contribution_invalid");
  }

  return ExtensionRegistrationStatusSchema.parse({
    namespace,
    id: manifest.id,
    version: manifest.version,
    capabilities: statusByCapability,
  });
}

function makeExtensionToolPort(tools: ReadonlyMap<string, RegisteredTool>): ToolPort | undefined {
  if (tools.size === 0) {
    return undefined;
  }
  const get = (toolId: string) => tools.get(toolId);
  const getToolSpecs = (): readonly ToolSpec[] =>
    [...tools.values()].filter((tool) => tool.isGranted()).map((tool) => ({
      toolId: tool.toolId,
      description: tool.description,
      inputSchema: tool.inputJsonSchema,
    }));
  const catalogFingerprints = (): Readonly<Record<string, Sha256HexType>> =>
    Object.fromEntries(
      [...tools.values()]
        .filter((tool) => tool.isGranted())
        .map((tool) => [
          tool.toolId,
          fingerprint(
            `${tool.extensionVersion}\0${tool.description}\0${canonicalJson(tool.inputJsonSchema)}`,
          ),
        ]),
    );
  const catalogVersion = () => {
    const fingerprints = catalogFingerprints();
    return Object.keys(fingerprints).length === 0
      ? undefined
      : fingerprint(canonicalJson(fingerprints));
  };
  const describe = (toolId: ReturnType<typeof Code.parse>): ToolDescription | undefined => {
    const tool = get(toolId);
    return tool === undefined || !tool.isGranted()
      ? undefined
      : {
          idempotent: false,
          timeoutMs: tool.timeoutMs,
          inputSchema: tool.inputJsonSchema,
        };
  };
  const execute = async (
    call: ModelToolCall,
    context: Parameters<NonNullable<ToolPort["execute"]>>[1],
  ): Promise<ToolExecutionResult> => {
    const tool = get(call.toolId);
    if (tool === undefined) {
      return { outcome: "error", errorCode: "unknown_tool", result: null };
    }
    if (!tool.isGranted()) {
      return { outcome: "error", errorCode: "extension_grant_missing", result: null };
    }
    context.signal.throwIfAborted();
    if (!isBoundedJsonValue(call.args)) {
      return { outcome: "error", errorCode: "extension_input_invalid", result: null };
    }
    let input: ReturnType<typeof tool.inputSchema.safeParse>;
    try {
      input = tool.inputSchema.safeParse(call.args);
    } catch {
      return { outcome: "error", errorCode: "extension_input_invalid", result: null };
    }
    if (!input.success) {
      return { outcome: "error", errorCode: "extension_input_invalid", result: null };
    }
    try {
      const output = await tool.execute(input.data, { signal: context.signal });
      context.signal.throwIfAborted();
      let parsedOutput: ReturnType<typeof tool.outputSchema.safeParse>;
      try {
        parsedOutput = tool.outputSchema.safeParse(output);
      } catch {
        return { outcome: "error", errorCode: "extension_result_invalid", result: null };
      }
      if (!parsedOutput.success) {
        return { outcome: "error", errorCode: "extension_result_invalid", result: null };
      }
      let result: JsonValue;
      try {
        if (!isBoundedJsonValue(parsedOutput.data, false, tool.maxOutputBytes)) {
          return { outcome: "error", errorCode: "extension_result_invalid", result: null };
        }
        result = JsonValueSchema.parse(parsedOutput.data);
      } catch {
        return { outcome: "error", errorCode: "extension_result_invalid", result: null };
      }
      return { outcome: "ok", result, resultLimitBytes: tool.maxOutputBytes };
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return { outcome: "error", errorCode: "extension_execution_failed", result: null };
    }
  };

  return {
    getToolSpecs,
    catalogVersion,
    catalogFingerprints,
    describe,
    execute,
    validateInputSchema: async (toolId, args) => {
      const tool = get(toolId);
      return (
        tool !== undefined &&
        tool.isGranted() &&
        isBoundedJsonValue(args) &&
        tool.inputSchema.safeParse(args).success
      );
    },
  };
}

function composeToolPorts(base: ToolPort | undefined, additions: ToolPort): ToolPort {
  const initialAdditionSpecs = additions.getToolSpecs?.() ?? [];
  const baseToolIds = new Set((base?.getToolSpecs?.() ?? []).map(({ toolId }) => toolId));
  for (const spec of initialAdditionSpecs) {
    if (baseToolIds.has(spec.toolId) || base?.describe(spec.toolId) !== undefined) {
      throw new ExtensionError("extension_contribution_invalid");
    }
  }
  const additionToolIds = new Set(initialAdditionSpecs.map(({ toolId }) => toolId));
  const getToolSpecs = () => [
    ...(base?.getToolSpecs?.() ?? []),
    ...(additions.getToolSpecs?.() ?? []),
  ];
  const catalogFingerprints = () => ({
    ...(base?.catalogFingerprints?.() ?? {}),
    ...(additions.catalogFingerprints?.() ?? {}),
  });
  const catalogVersion = () => {
    const baseVersion = base?.catalogVersion?.();
    const additionalVersion = additions.catalogVersion?.();
    return baseVersion === undefined && additionalVersion === undefined
      ? undefined
      : fingerprint(`${baseVersion ?? ""}\0${additionalVersion ?? ""}`);
  };
  const portFor = (toolId: ReturnType<typeof Code.parse>): ToolPort =>
    additionToolIds.has(toolId) ? additions : (base ?? additions);
  const pinForRun: ToolPort["pinForRun"] =
    base?.pinForRun === undefined
      ? undefined
      : async (options) =>
          composeToolPorts(await base.pinForRun?.(options), additions);
  const prepare: ToolPort["prepare"] =
    base?.prepare === undefined ? undefined : (call, context) => base.prepare?.(call, context) ?? Promise.resolve(call);
  const validateInputSchema: ToolPort["validateInputSchema"] =
    base?.validateInputSchema === undefined
      ? additions.validateInputSchema === undefined
        ? undefined
        : (toolId, args, schema, context) =>
            portFor(toolId).validateInputSchema?.(toolId, args, schema, context) ?? Promise.resolve(true)
      : (toolId, args, schema, context) =>
          portFor(toolId).validateInputSchema?.(toolId, args, schema, context) ?? Promise.resolve(true);
  return {
    ...(pinForRun === undefined ? {} : { pinForRun }),
    ...(prepare === undefined ? {} : { prepare }),
    ...(validateInputSchema === undefined ? {} : { validateInputSchema }),
    getToolSpecs,
    catalogVersion,
    catalogFingerprints,
    describe: (toolId, args) => portFor(toolId).describe(toolId, args),
    resumeStrategy: (toolId) => portFor(toolId).resumeStrategy?.(toolId),
    execute: (call, context) => portFor(call.toolId).execute(call, context),
  };
}

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
  const namespaces = new Set<string>();
  const identities = new Set<string>();
  const tools = new Map<string, RegisteredTool>();
  const providers = new Map<string, ProviderAdapter>();
  const activeGrants = new Map<string, Set<string>>();
  const records: {
    readonly namespace: string;
    readonly manifest: ExtensionManifest;
  }[] = [];
  for (const provider of baseProviders) {
    if (!validateProviderAdapter(provider) || providers.has(provider.provider)) {
      throw new ExtensionError("extension_contribution_invalid");
    }
    providers.set(provider.provider, provider);
  }
  for (const registration of registrations) {
    const boundedRegistration = {
      ...registration,
      toolTimeoutMs: Math.min(
        registration.toolTimeoutMs ?? DEFAULT_EXTENSION_TOOL_TIMEOUT_MS,
        maxWallClockMs,
      ),
    };
    registerOne(boundedRegistration, namespaces, identities, tools, providers, activeGrants);
    records.push({
      namespace: registration.namespace,
      manifest: ExtensionManifestSchema.parse(registration.definition.manifest),
    });
  }
  const extensionToolPort = makeExtensionToolPort(tools);
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
              activeGrants.get(namespace) ?? new Set<string>(),
            ),
        ),
      }),
    );
  const revokeGrant = ({ namespace, kind, target }: ExtensionGrantRevocation) => {
    const grants = activeGrants.get(namespace);
    if (grants === undefined) {
      return false;
    }
    return grants.delete(grantTarget(kind, target));
  };
  return {
    ...(extensionToolPort === undefined
      ? baseTool === undefined
        ? {}
        : { tool: baseTool }
      : { tool: composeToolPorts(baseTool, extensionToolPort) }),
    providers: [...providers.values()],
    getStatuses,
    revokeGrant,
  };
}
