// SPDX-License-Identifier: Apache-2.0
import { Code, HarnessError, type JsonValue } from "@rovinos/schemas";
import type { ProviderAdapter } from "@rovinos/models";
import { z } from "zod";
import { BoundedJsonValueSchema } from "./extension-json.js";
import {
  DEFAULT_EXTENSION_OUTPUT_BYTES,
  DEFAULT_EXTENSION_TOOL_TIMEOUT_MS,
  MAX_CAPABILITIES,
  MAX_CAPABILITY_TARGETS,
  MAX_EXTENSION_JSON_BYTES,
  MAX_EXTENSION_TOOL_TIMEOUT_MS,
  VERSION_PATTERN,
} from "./extension-constants.js";
import { isValidSdkRangeSyntax } from "./extension-runtime-helpers.js";

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

const CapabilityTargets = z
  .array(Code)
  .min(1)
  .max(MAX_CAPABILITY_TARGETS)
  .refine(
    (targets) => new Set(targets).size === targets.length,
    "Capability targets must be unique.",
  );

/** Closed capability requests. These declarations describe needs; they never grant access. */
export const ExtensionCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tools.contribute"), names: CapabilityTargets }).strict(),
  z.object({ kind: z.literal("providers.contribute"), providers: CapabilityTargets }).strict(),
  z
    .object({
      kind: z.literal("events.observe"),
      kinds: z.array(SafeEventKindSchema).min(1).max(12),
    })
    .strict(),
  z.object({ kind: z.literal("content.read"), bindings: CapabilityTargets }).strict(),
]);

/** Inferred extension capability request. */
export type ExtensionCapability = z.infer<typeof ExtensionCapabilitySchema>;

const CapabilityListSchema = z
  .array(ExtensionCapabilitySchema)
  .max(MAX_CAPABILITIES)
  .refine((capabilities) => {
    const seen = new Set<string>();
    for (const capability of capabilities) {
      if (seen.has(capability.kind)) {
        return false;
      }
      seen.add(capability.kind);
    }
    return true;
  }, "Capability declarations must be unique.");

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
export function defineTool<InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ExtensionToolDefinition<InputSchema, OutputSchema>,
): ExtensionToolDefinition<InputSchema, OutputSchema> {
  return definition;
}

/** Contributions created after the SDK validates a manifest, configuration and operator grants. */
export interface ExtensionContributions {
  readonly tools?: readonly ExtensionToolDefinition[];
  readonly providers?: readonly ProviderAdapter[];
}

/** Runtime guard for direct SDK registration; authoring helpers are not required. */
export const ExtensionDefinitionSchema = z
  .object({
    manifest: ExtensionManifestSchema,
    configSchema: z.custom<z.ZodType>((value) => value instanceof z.ZodType),
    createContributions: z.custom<(config: unknown) => ExtensionContributions>(
      (value) => typeof value === "function",
    ),
  })
  .strict();

/** SDK-owned extension definition. Its callback is trusted in-process application code. */
export type ExtensionDefinition<ConfigSchema extends z.ZodType = z.ZodType> = Omit<
  z.infer<typeof ExtensionDefinitionSchema>,
  "configSchema" | "createContributions"
> & {
  readonly configSchema: ConfigSchema;
  createContributions(config: z.output<ConfigSchema>): ExtensionContributions;
};

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
export type ExtensionRegistration<Definition extends ExtensionDefinition = ExtensionDefinition> =
  Omit<z.input<typeof ExtensionRegistrationSchema>, "definition" | "config"> & {
    readonly definition: Definition;
    readonly config?: (z.input<Definition["configSchema"]> & JsonValue) | undefined;
  };

/** Metadata describing which requested capabilities are enabled or explicitly unsupported. */
export const ExtensionCapabilityStatusSchema = z
  .object({
    kind: z.enum(["tools.contribute", "providers.contribute", "events.observe", "content.read"]),
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

type ExtensionErrorCode =
  | "extension_manifest_invalid"
  | "extension_incompatible"
  | "extension_config_invalid"
  | "extension_grant_missing"
  | "extension_grant_invalid"
  | "extension_capability_unsupported"
  | "extension_contribution_invalid"
  | "extension_schema_unsupported"
  | "extension_input_invalid"
  | "extension_result_invalid"
  | "extension_execution_failed";

/** Typed extension registration and execution failure without untrusted values. */
export class ExtensionError extends HarnessError {
  readonly code: ExtensionErrorCode;

  /** Creates a stable extension error that does not include extension-controlled data. */
  constructor(code: ExtensionErrorCode) {
    super(`Extension operation failed (${code}).`);
    this.code = code;
    this.name = "ExtensionError";
  }
}
