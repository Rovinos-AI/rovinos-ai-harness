// SPDX-License-Identifier: Apache-2.0
// Config discovery follows explicit path, environment path, then the working-directory default.
import { readFile as readFileFromDisk } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ContractError,
  HarnessError,
  isSecretKeyName,
  SecretRefSchema,
  parseJson,
  parseYaml,
} from "@harness/schemas";
import { z } from "zod";
import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

const unknownValueSchema = z.unknown();
const blockedPathSegments = new Set(["__proto__", "constructor", "prototype"]);

/** A file reader injected by config-loader tests or callers. */
export type ConfigFileReader = (path: string) => Promise<string>;

/** Options for loading and validating a harness config file. */
export interface LoadConfigOptions {
  /** Optional explicit YAML or JSON config path. */
  readonly configPath?: string;
  /** Current directory used to resolve relative config paths. */
  readonly cwd?: string;
  /** Environment source; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Config file reader; defaults to Node's `fs/promises.readFile`. */
  readonly readFile?: ConfigFileReader;
}

/** Safe error raised when a configuration file or environment override is invalid. */
export class ConfigError extends HarnessError {
  readonly code = "config_invalid";
  readonly issues: readonly string[];

  /**
   * Creates a value-free configuration error.
   *
   * @param issues - Sanitized paths, expectations, and error codes.
   */
  constructor(issues: readonly string[]) {
    const safeIssues = [...issues];
    super(`Configuration validation failed:\n${safeIssues.join("\n")}`);
    this.name = "ConfigError";
    this.issues = Object.freeze(safeIssues);
  }
}

function expectedForIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "too_small":
      return `${issue.inclusive === false ? "greater than" : "at least"} ${String(issue.minimum)}`;
    case "too_big":
      return `${issue.inclusive === false ? "less than" : "at most"} ${String(issue.maximum)}`;
    case "unrecognized_keys":
      return `${issue.keys.length === 1 ? "unknown key" : "unknown keys"} ${issue.keys
        .map((key) => JSON.stringify(key))
        .join(", ")}`;
    case "invalid_value":
      return "an allowed value";
    case "invalid_format":
      return "a valid format";
    case "custom":
    case "invalid_element":
    case "invalid_key":
    case "invalid_union":
      return "a valid configuration value";
    case "not_multiple_of":
      return `a multiple of ${String(issue.divisor)}`;
  }
  return "a valid configuration value";
}

/**
 * Formats Zod issues without exposing invalid input values.
 *
 * @param issues - Issues returned by Zod validation.
 * @returns One path, expectation, and issue code per validation failure.
 */
export function formatConfigIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const pathSegments = issue.path.map(String);
    const path = pathSegments.length === 0 ? "configuration" : pathSegments.join(".");
    const code =
      issue.code === "custom" && typeof issue.params?.errorCode === "string"
        ? issue.params.errorCode
        : issue.code;
    return `${path}: ${expectedForIssue(issue)} (${code})`;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.prototype.toString.call(value) === "[object Object]";
}

type ConfigContainer = Record<string, unknown> | unknown[];

interface InlineSecretScanState {
  readonly visited: WeakSet<ConfigContainer>;
  readonly active: WeakSet<ConfigContainer>;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function configContainer(value: unknown): ConfigContainer | undefined {
  if (isUnknownArray(value)) {
    return value;
  }
  if (isRecord(value)) {
    return value;
  }
  return undefined;
}

function inlineSecretChildIssues(
  key: string,
  child: unknown,
  path: readonly (string | number)[],
  state: InlineSecretScanState,
): string[] {
  const childPath = [...path, key];
  const childPathText = childPath.map(String).join(".");
  const issues =
    isSecretKeyName(key) && typeof child === "string" && !SecretRefSchema.safeParse(child).success
      ? [`${childPathText}: a SecretRef (secret_inline)`]
      : [];
  return [...issues, ...inlineSecretIssues(child, childPath, state)];
}

function containerChildrenIssues(
  container: ConfigContainer,
  path: readonly (string | number)[],
  state: InlineSecretScanState,
): string[] {
  if (isUnknownArray(container)) {
    return container.flatMap((child, index) => inlineSecretIssues(child, [...path, index], state));
  }
  return Object.entries(container).flatMap(([key, child]) =>
    inlineSecretChildIssues(key, child, path, state),
  );
}

function inlineSecretIssues(
  value: unknown,
  path: readonly (string | number)[] = [],
  state: InlineSecretScanState = {
    visited: new WeakSet<ConfigContainer>(),
    active: new WeakSet<ConfigContainer>(),
  },
): string[] {
  const container = configContainer(value);
  if (container === undefined) {
    return [];
  }
  const pathText = path.length === 0 ? "configuration" : path.map(String).join(".");
  if (state.active.has(container)) {
    return [`${pathText}: acyclic configuration value (config_cycle)`];
  }
  if (state.visited.has(container)) {
    return [];
  }
  state.visited.add(container);
  state.active.add(container);
  const issues = containerChildrenIssues(container, path, state);
  state.active.delete(container);
  return issues;
}

function assertNoInlineSecrets(value: unknown): void {
  const issues = inlineSecretIssues(value);
  if (issues.length > 0) {
    throw new ConfigError(issues);
  }
}

function unwrapSchema(schema: z.core.$ZodType): z.core.$ZodType {
  let current = schema;
  while (
    current instanceof z.core.$ZodDefault ||
    current instanceof z.core.$ZodPrefault ||
    current instanceof z.core.$ZodOptional ||
    current instanceof z.core.$ZodNullable
  ) {
    current = current._zod.def.innerType;
  }
  return current;
}

function schemaObjectShape(schema: z.core.$ZodType): z.core.$ZodShape | undefined {
  const unwrapped = unwrapSchema(schema);
  return unwrapped instanceof z.core.$ZodObject ? unwrapped._zod.def.shape : undefined;
}

function schemaDiscriminatedUnion(
  schema: z.core.$ZodType,
): { readonly discriminator: string; readonly options: readonly z.core.$ZodType[] } | undefined {
  const unwrapped = unwrapSchema(schema);
  return unwrapped instanceof z.core.$ZodDiscriminatedUnion ? unwrapped._zod.def : undefined;
}

function normalizedSegment(segment: string): string {
  return segment.toLowerCase().replaceAll(/[_-]/g, "");
}

function invalidEnvironmentPath(key: string): never {
  throw new ConfigError([
    `${key}: unknown, ambiguous, or unsupported configuration path (config_env_invalid)`,
  ]);
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function environmentValueAtPath(
  key: string,
  env: Readonly<Record<string, string | undefined>>,
  path: readonly string[],
): string | undefined {
  const expected = path.map(normalizedSegment);
  const matches = Object.entries(env).filter(([envKey, value]) => {
    if (!envKey.startsWith("HARNESS__") || value === undefined) {
      return false;
    }
    const segments = envKey.slice("HARNESS__".length).split("__");
    return (
      segments.length === expected.length &&
      segments.every((segment, index) => normalizedSegment(segment) === expected[index])
    );
  });
  if (matches.length > 1) {
    invalidEnvironmentPath(key);
  }
  return matches[0]?.[1];
}

function resolveEnvironmentPath(
  key: string,
  segments: readonly string[],
  config: unknown,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const resolved: string[] = [];
  let currentSchema: z.core.$ZodType = HarnessConfigSchema;

  for (const segment of segments) {
    const union = schemaDiscriminatedUnion(currentSchema);
    if (union !== undefined) {
      if (normalizedSegment(segment) === normalizedSegment(union.discriminator)) {
        const firstOption = union.options[0];
        const discriminatorSchema =
          firstOption === undefined
            ? undefined
            : schemaObjectShape(firstOption)?.[union.discriminator];
        if (discriminatorSchema === undefined) {
          invalidEnvironmentPath(key);
        }
        resolved.push(union.discriminator);
        currentSchema = discriminatorSchema;
        continue;
      }

      const discriminatorPath = [...resolved, union.discriminator];
      const discriminatorValue =
        environmentValueAtPath(key, env, discriminatorPath) ??
        valueAtPath(config, discriminatorPath);
      const matchingOptions = union.options.filter((option) => {
        const discriminatorSchema = schemaObjectShape(option)?.[union.discriminator];
        return (
          discriminatorSchema !== undefined &&
          z.safeParse(discriminatorSchema, discriminatorValue).success
        );
      });
      if (matchingOptions.length !== 1) {
        invalidEnvironmentPath(key);
      }
      const selectedOption = matchingOptions[0];
      if (selectedOption === undefined) {
        invalidEnvironmentPath(key);
      }
      currentSchema = selectedOption;
    }

    const shape = schemaObjectShape(currentSchema);
    if (shape === undefined) {
      invalidEnvironmentPath(key);
    }

    const matchingKeys = Object.keys(shape).filter(
      (knownKey) => normalizedSegment(knownKey) === normalizedSegment(segment),
    );
    if (matchingKeys.length !== 1) {
      invalidEnvironmentPath(key);
    }

    const matchedKey = matchingKeys[0];
    if (matchedKey === undefined) {
      invalidEnvironmentPath(key);
    }
    resolved.push(matchedKey);
    const childSchema = shape[matchedKey];
    if (childSchema === undefined) {
      invalidEnvironmentPath(key);
    }
    currentSchema = childSchema;
  }

  if (unwrapSchema(currentSchema) instanceof z.core.$ZodArray) {
    invalidEnvironmentPath(key);
  }
  return resolved;
}

function environmentOverrides(
  env: Readonly<Record<string, string | undefined>>,
  config: unknown,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith("HARNESS__") && value !== undefined)
    .sort(([left], [right]) => left.split("__").length - right.split("__").length);

  for (const [key, value] of entries) {
    const segments = key.slice("HARNESS__".length).split("__");
    if (
      segments.length === 0 ||
      segments.some(
        (segment) => segment.length === 0 || blockedPathSegments.has(segment.toLowerCase()),
      )
    ) {
      invalidEnvironmentPath(key);
    }
    const path = resolveEnvironmentPath(key, segments, config, env);

    let current = root;
    for (const segment of path.slice(0, -1)) {
      const child = current[segment];
      if (!isRecord(child)) {
        const nested: Record<string, unknown> = {};
        current[segment] = nested;
        current = nested;
      } else {
        current = child;
      }
    }
    const leaf = path.at(-1);
    if (leaf === undefined) {
      invalidEnvironmentPath(key);
    }
    current[leaf] = value;
  }
  return root;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override;
  }
  const merged = Object.fromEntries(Object.entries(base));
  for (const [key, value] of Object.entries(override)) {
    merged[key] = Object.hasOwn(base, key) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach((child: unknown) => deepFreeze(child));
  return Object.freeze(value);
}

function formatContractIssues(error: ContractError): string[] {
  return error.issues.map(({ path, code }) => {
    const pathSegments = path.map(String);
    const issuePath = pathSegments.length === 0 ? "configuration" : pathSegments.join(".");
    const expected =
      code === "invalid_json" || code === "invalid_yaml"
        ? "valid YAML or JSON"
        : "valid configuration content";
    return `${issuePath}: ${expected} (${code})`;
  });
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Loads, merges, validates, and deeply freezes a harness configuration.
 *
 * Config file selection order is `configPath`, `HARNESS_CONFIG`, then
 * `harness.config.yaml` in `cwd`. Environment overrides use the
 * `HARNESS__PATH__KEY` convention and take precedence over file values.
 * Arrays cannot be overridden by environment variables.
 *
 * @param options - File discovery, environment, and testable I/O dependencies.
 * @returns A strictly validated, deeply frozen configuration.
 * @throws ConfigError when the file cannot be read or any value is invalid.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<HarnessConfig> {
  const env = options.env ?? process.env;
  const explicitPath = options.configPath !== undefined || env.HARNESS_CONFIG !== undefined;
  const configPath = options.configPath ?? env.HARNESS_CONFIG ?? "harness.config.yaml";
  const absolutePath = resolve(options.cwd ?? process.cwd(), configPath);
  const readFile: ConfigFileReader =
    options.readFile ?? ((path) => readFileFromDisk(path, { encoding: "utf8" }));

  let parsedFile: unknown;
  try {
    const contents = await readFile(absolutePath);
    parsedFile = absolutePath.toLowerCase().endsWith(".json")
      ? parseJson(unknownValueSchema, contents)
      : parseYaml(unknownValueSchema, contents);
  } catch (error) {
    if (error instanceof ContractError) {
      throw new ConfigError(formatContractIssues(error));
    }
    if (!explicitPath && isFileNotFound(error)) {
      parsedFile = {};
    } else {
      throw new ConfigError([
        "configuration: readable YAML or JSON config file (config_file_unavailable)",
      ]);
    }
  }

  const merged = deepMerge(parsedFile, environmentOverrides(env, parsedFile));
  assertNoInlineSecrets(merged);
  const result = HarnessConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(formatConfigIssues(result.error.issues));
  }
  return deepFreeze(result.data);
}
