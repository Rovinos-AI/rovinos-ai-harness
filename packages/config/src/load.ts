// SPDX-License-Identifier: Apache-2.0
// Config discovery follows explicit path, environment path, then the working-directory default.
import { readFile as readFileFromDisk } from "node:fs/promises";
import { resolve } from "node:path";
import { ContractError, parseJson, parseYaml } from "@harness/schemas";
import { z } from "zod";
import { HarnessConfigSchema, type HarnessConfig } from "./schema.js";

const unknownValueSchema = z.unknown();
const blockedPathSegments = new Set(["__proto__", "constructor", "prototype"]);
const keyAliases = new Map([["maxsteps", "maxSteps"]]);

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
export class ConfigError extends Error {
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
      return "known configuration keys";
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
    return `${path}: ${expectedForIssue(issue)} (${issue.code})`;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.prototype.toString.call(value) === "[object Object]";
}

function camelCaseSegment(segment: string): string {
  const lowerCase = segment.toLowerCase();
  const alias = keyAliases.get(lowerCase);
  if (alias !== undefined) {
    return alias;
  }
  return lowerCase.replaceAll(/[_-]+([a-z0-9])/g, (_match, character: string) =>
    character.toUpperCase(),
  );
}

function environmentOverrides(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith("HARNESS__") && value !== undefined)
    .sort(([left], [right]) => left.split("__").length - right.split("__").length);

  for (const [key, value] of entries) {
    const path = key.slice("HARNESS__".length).split("__").map(camelCaseSegment);
    if (
      path.length === 0 ||
      path.some((segment) => segment.length === 0 || blockedPathSegments.has(segment))
    ) {
      throw new ConfigError(["environment: valid HARNESS__ override path (config_env_invalid)"]);
    }

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
      throw new ConfigError(["environment: valid HARNESS__ override path (config_env_invalid)"]);
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
    throw new ConfigError([
      "configuration: readable YAML or JSON config file (config_file_unavailable)",
    ]);
  }

  const merged = deepMerge(parsedFile, environmentOverrides(env));
  const result = HarnessConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(formatConfigIssues(result.error.issues));
  }
  return deepFreeze(result.data);
}
