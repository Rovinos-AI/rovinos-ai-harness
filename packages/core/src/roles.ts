// SPDX-License-Identifier: Apache-2.0
import { realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Code,
  HarnessError,
  RoleConfigSchema,
  type Code as CodeType,
  type ModelsConfig,
  type RoleConfig,
  type RoleToolPattern,
} from "@harness/schemas";
import { z } from "zod";

/** Stable codes emitted for role startup and lookup failures. */
export type RoleRegistryErrorCode =
  | "role_config_invalid"
  | "role_id_duplicate"
  | "role_route_unknown"
  | "role_context_strategy_unknown"
  | "role_result_schema_invalid"
  | "role_prompt_path_invalid"
  | "role_prompt_unavailable"
  | "role_prompt_too_large"
  | "role_not_found";

/** Role validation failure carrying a stable code without config values. */
export class RoleRegistryError extends HarnessError {
  readonly code: RoleRegistryErrorCode;

  /**
   * @param code - Stable role validation or lookup code.
   */
  constructor(code: RoleRegistryErrorCode) {
    super(`Role configuration failed (${code}).`);
    this.code = code;
  }
}

/** A non-fatal warning raised while expanding a role's tool patterns. */
export interface RoleRegistryWarning {
  readonly code: "role_tool_pattern_unmatched";
  readonly roleId: CodeType;
  readonly pattern: RoleToolPattern;
}

/** Role after startup resolution of prompts, routes, tools, and schemas. */
export interface ResolvedRole {
  readonly id: CodeType;
  readonly route?: CodeType;
  readonly systemPrompt?: string;
  readonly tools: readonly CodeType[];
  readonly budgets?: RoleConfig["budgets"];
  readonly contextStrategy?: CodeType;
  readonly resultSchema?: z.ZodType;
  readonly maxDepth: number;
  readonly maxChildren: number;
}

/** Loads a role's referenced result-schema module. */
export type RoleSchemaLoader = (specifier: string) => Promise<unknown>;

/** Inputs needed to validate and resolve a role set during startup. */
export interface RoleRegistryOptions {
  readonly roles?: readonly unknown[];
  readonly models: ModelsConfig;
  readonly registeredTools: readonly CodeType[];
  readonly contextStrategies: ReadonlySet<CodeType>;
  readonly configDirectory: string;
  readonly onWarning?: (warning: RoleRegistryWarning) => void;
  readonly loadSchema?: RoleSchemaLoader;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  if (isZodSchema(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((child: unknown) => deepFreeze(child));
  } else if (Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach((child: unknown) => deepFreeze(child));
  }
  return Object.freeze(value);
}

function isZodSchema(value: unknown): value is z.ZodType {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { readonly safeParse?: unknown; readonly _zod?: unknown };
  return (
    typeof candidate.safeParse === "function" &&
    typeof candidate._zod === "object" &&
    candidate._zod !== null
  );
}

/**
 * Built-in roles share routing IDs with the model routing config.
 * Judge and summarizer start without tool access; planner and worker inherit
 * the registered tool set unless their role config narrows it.
 */
export const BUILTIN_ROLE_DEFAULTS: readonly RoleConfig[] = deepFreeze([
  RoleConfigSchema.parse({ id: "planner", tools: "*" }),
  RoleConfigSchema.parse({ id: "worker", tools: "*" }),
  RoleConfigSchema.parse({ id: "judge", tools: [] }),
  RoleConfigSchema.parse({ id: "summarizer", tools: [] }),
]);

function isWithinDirectory(directory: string, target: string): boolean {
  const pathFromRoot = relative(directory, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function matchesPattern(pattern: RoleToolPattern, toolId: CodeType): boolean {
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(toolId);
}

async function readPromptFile(file: string, configDirectory: string): Promise<string> {
  let root: string;
  let requestedPath: string;
  try {
    root = await realpath(configDirectory);
    requestedPath = resolve(root, file);
  } catch {
    throw new RoleRegistryError("role_prompt_path_invalid");
  }
  if (!isWithinDirectory(root, requestedPath)) {
    throw new RoleRegistryError("role_prompt_path_invalid");
  }

  try {
    const promptPath = await realpath(requestedPath);
    if (!isWithinDirectory(root, promptPath)) {
      throw new RoleRegistryError("role_prompt_path_invalid");
    }
    const prompt = await readFile(promptPath, "utf8");
    if (prompt.length > 8_000) {
      throw new RoleRegistryError("role_prompt_too_large");
    }
    return prompt;
  } catch (error) {
    if (error instanceof RoleRegistryError) {
      throw error;
    }
    throw new RoleRegistryError("role_prompt_unavailable");
  }
}

async function defaultSchemaLoader(specifier: string): Promise<unknown> {
  return import(specifier);
}

async function loadResultSchema(
  reference: string,
  configDirectory: string,
  loadSchema: RoleSchemaLoader,
): Promise<z.ZodType> {
  const exportSeparator = reference.lastIndexOf("#");
  if (exportSeparator <= 0 || exportSeparator === reference.length - 1) {
    throw new RoleRegistryError("role_result_schema_invalid");
  }
  const moduleName = reference.slice(0, exportSeparator);
  const exportName = reference.slice(exportSeparator + 1);
  const specifier =
    moduleName.startsWith(".") || isAbsolute(moduleName)
      ? pathToFileURL(resolve(configDirectory, moduleName)).href
      : moduleName;

  try {
    const namespace = await loadSchema(specifier);
    if (
      typeof namespace !== "object" ||
      namespace === null ||
      !Object.hasOwn(namespace, exportName)
    ) {
      throw new RoleRegistryError("role_result_schema_invalid");
    }
    const schema: unknown = Reflect.get(namespace, exportName);
    if (!isZodSchema(schema)) {
      throw new RoleRegistryError("role_result_schema_invalid");
    }
    return schema;
  } catch (error) {
    if (error instanceof RoleRegistryError) {
      throw error;
    }
    throw new RoleRegistryError("role_result_schema_invalid");
  }
}

function expandTools(
  role: RoleConfig,
  registeredTools: readonly CodeType[],
  warnings: RoleRegistryWarning[],
): CodeType[] {
  if (role.tools === "*") {
    if (registeredTools.length === 0) {
      warnings.push({ code: "role_tool_pattern_unmatched", roleId: role.id, pattern: "*" });
    }
    return [...registeredTools];
  }

  const resolved = new Set<CodeType>();
  for (const pattern of role.tools) {
    const matches = registeredTools.filter((toolId) => matchesPattern(pattern, toolId));
    if (matches.length === 0) {
      warnings.push({
        code: "role_tool_pattern_unmatched",
        roleId: role.id,
        pattern,
      });
    }
    matches.forEach((toolId) => resolved.add(toolId));
  }
  return [...resolved];
}

async function resolveRoleConfig(
  role: RoleConfig,
  options: RoleRegistryOptions,
  warnings: RoleRegistryWarning[],
): Promise<ResolvedRole> {
  const route = role.route;
  if (route !== undefined && !Object.hasOwn(options.models.routing.roles, route)) {
    throw new RoleRegistryError("role_route_unknown");
  }
  if (role.contextStrategy !== undefined && !options.contextStrategies.has(role.contextStrategy)) {
    throw new RoleRegistryError("role_context_strategy_unknown");
  }

  let systemPrompt: string | undefined;
  if (typeof role.systemPrompt === "string") {
    systemPrompt = role.systemPrompt;
  } else if (role.systemPrompt !== undefined) {
    systemPrompt = await readPromptFile(role.systemPrompt.file, options.configDirectory);
  }

  let resultSchema: z.ZodType | undefined;
  if (role.resultSchema !== undefined) {
    resultSchema = await loadResultSchema(
      role.resultSchema,
      options.configDirectory,
      options.loadSchema ?? defaultSchemaLoader,
    );
  }

  return deepFreeze({
    id: role.id,
    ...(route === undefined ? {} : { route }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    tools: expandTools(role, options.registeredTools, warnings),
    ...(role.budgets === undefined ? {} : { budgets: role.budgets }),
    ...(role.contextStrategy === undefined ? {} : { contextStrategy: role.contextStrategy }),
    ...(resultSchema === undefined ? {} : { resultSchema }),
    maxDepth: role.maxDepth,
    maxChildren: role.maxChildren,
  });
}

/**
 * Resolves built-in and configured roles after validating their dependencies.
 *
 * @param options - Validated role, model, tool, strategy, and filesystem inputs.
 * @returns An immutable registry ready for role lookup.
 */
export class RoleRegistry {
  readonly warnings: readonly RoleRegistryWarning[];
  private readonly roles: ReadonlyMap<CodeType, ResolvedRole>;

  private constructor(
    roles: ReadonlyMap<CodeType, ResolvedRole>,
    warnings: readonly RoleRegistryWarning[],
  ) {
    this.roles = roles;
    this.warnings = deepFreeze([...warnings]);
  }

  /**
   * Validates and resolves the full role set before the registry is used.
   *
   * @param options - Registered routes/tools/strategies and config directory.
   * @returns A registry containing all four built-ins and configured overrides.
   */
  static async create(options: RoleRegistryOptions): Promise<RoleRegistry> {
    let configuredRoles: RoleConfig[];
    try {
      configuredRoles =
        options.roles === undefined
          ? []
          : options.roles.map((role) => RoleConfigSchema.parse(role));
    } catch {
      throw new RoleRegistryError("role_config_invalid");
    }

    const configuredIds = new Set<CodeType>();
    for (const role of configuredRoles) {
      if (configuredIds.has(role.id)) {
        throw new RoleRegistryError("role_id_duplicate");
      }
      configuredIds.add(role.id);
    }

    const rolesById = new Map<CodeType, RoleConfig>(
      BUILTIN_ROLE_DEFAULTS.map((role) => [role.id, role]),
    );
    configuredRoles.forEach((role) => rolesById.set(role.id, role));

    const warnings: RoleRegistryWarning[] = [];
    const resolved = new Map<CodeType, ResolvedRole>();
    for (const role of rolesById.values()) {
      const resolvedRole = await resolveRoleConfig(role, options, warnings);
      resolved.set(role.id, resolvedRole);
    }
    warnings.forEach((warning) => options.onWarning?.(warning));
    return new RoleRegistry(resolved, warnings);
  }

  /**
   * Returns a frozen role definition.
   *
   * @param name - Role identifier to resolve.
   * @returns The immutable resolved role.
   * @throws RoleRegistryError when the identifier is not registered.
   */
  resolveRole(name: CodeType): ResolvedRole {
    const role = this.roles.get(name);
    if (role === undefined) {
      throw new RoleRegistryError("role_not_found");
    }
    return role;
  }
}

/**
 * Resolves a role by name through an already validated registry.
 *
 * @param name - Role identifier to resolve.
 * @param registry - Startup-validated role registry.
 * @returns The immutable resolved role.
 */
export function resolveRole(name: CodeType, registry: RoleRegistry): ResolvedRole {
  const validatedName = Code.parse(name);
  return registry.resolveRole(validatedName);
}
