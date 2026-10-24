// SPDX-License-Identifier: Apache-2.0
import {
  listLogDefinitions,
  listSpanDefinitions,
  METRIC_ALLOWLIST,
  type LogRecordDefinition,
  type LogRecordShape,
  type SpanDefinition,
  type SpanDefinitionShape,
} from "@harness/telemetry";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as RegistrationSourceModule from "./telemetry-registration-sources.js";

type CollectorSpanDefinition = Pick<SpanDefinition<SpanDefinitionShape>, "name" | "shape">;
type CollectorLogDefinition = Pick<LogRecordDefinition, "name" | "shape">;
interface YamlObject {
  readonly [key: string]: YamlValue;
}

type YamlListItem = string | YamlObject;
type YamlValue = string | readonly YamlListItem[] | YamlObject;

const resourceAttributeKeys = [
  "harness.policy.version",
  "service.name",
  "service.version",
  "telemetry.sdk.language",
  "telemetry.sdk.name",
  "telemetry.sdk.version",
];

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function ottlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function keepKeys(path: string, keys: readonly string[]): string {
  return `keep_keys(${path}, [${[...keys].sort(compareNames).map(ottlString).join(", ")}])`;
}

function dropUnlessRegistered(path: string, names: readonly string[]): string {
  if (names.length === 0) {
    return "true";
  }
  const conditions = [...names]
    .sort(compareNames)
    .map((name) => `${path} == ${ottlString(name)}`)
    .join(" or ");
  return `not (${conditions})`;
}

function isYamlList(value: YamlValue): value is readonly YamlListItem[] {
  return Array.isArray(value);
}

function attributeNames(shape: LogRecordShape | SpanDefinitionShape): string[] {
  return Object.keys(shape).sort(compareNames);
}

function createMetricAttributesProcessor(
  metricNames: readonly string[],
  metricAllowlist: Readonly<Record<string, readonly string[]>>,
): YamlObject {
  return {
    error_mode: "ignore",
    metric_statements: [
      {
        context: "scope",
        statements: [keepKeys("attributes", [])],
      },
      {
        context: "exemplar",
        statements: [keepKeys("filtered_attributes", [])],
      },
      {
        context: "datapoint",
        statements: metricNames.map(
          (name) =>
            `${keepKeys("attributes", metricAllowlist[name] ?? [])} where metric.name == ${ottlString(name)}`,
        ),
      },
    ],
  };
}

const pipelines: YamlValue = {
  traces: {
    processors: [
      "memory_limiter",
      "filter/drop_unregistered_spans",
      "filter/drop_span_events",
      "transform/span_attributes",
      "transform/resource_attributes",
      "resource/policy_version",
      "batch",
    ],
  },
  logs: {
    processors: [
      "memory_limiter",
      "filter/drop_unregistered_logs",
      "transform/log_attributes",
      "transform/resource_attributes",
      "resource/policy_version",
      "batch",
    ],
  },
  metrics: {
    processors: [
      "memory_limiter",
      "filter/drop_unregistered_metrics",
      "transform/metric_attributes",
      "transform/resource_attributes",
      "resource/policy_version",
      "batch",
    ],
  },
};

function renderYamlEntry(
  key: string,
  value: YamlValue,
  indentation: number,
  listItem = false,
): string[] {
  const prefix = " ".repeat(indentation);
  const keyPrefix = `${prefix}${listItem ? "- " : ""}`;
  if (typeof value === "string") {
    return [`${keyPrefix}${key}: ${JSON.stringify(value)}`];
  }
  if (isYamlList(value)) {
    if (value.length === 0) {
      return [`${keyPrefix}${key}: []`];
    }
    return [
      `${keyPrefix}${key}:`,
      ...value.flatMap((item) => {
        if (typeof item === "string") {
          return [`${prefix}  - ${JSON.stringify(item)}`];
        }
        return Object.entries(item).flatMap(([nestedKey, nestedValue], index) =>
          renderYamlEntry(nestedKey, nestedValue, indentation + (index === 0 ? 2 : 4), index === 0),
        );
      }),
    ];
  }
  return [
    `${keyPrefix}${key}:`,
    ...Object.entries(value).flatMap(([nestedKey, nestedValue]) =>
      renderYamlEntry(nestedKey, nestedValue, indentation + 2),
    ),
  ];
}

function createProcessors(
  spans: readonly CollectorSpanDefinition[],
  logs: readonly CollectorLogDefinition[],
  metricNames: readonly string[],
  metricAllowlist: Readonly<Record<string, readonly string[]>>,
): YamlValue {
  return {
    "filter/drop_unregistered_spans": {
      error_mode: "ignore",
      traces: {
        span: [
          dropUnlessRegistered(
            "name",
            spans.map(({ name }) => name),
          ),
        ],
      },
    },
    "filter/drop_span_events": {
      error_mode: "ignore",
      traces: { spanevent: ["true"] },
    },
    "transform/span_attributes": {
      error_mode: "ignore",
      trace_statements: [
        keepKeys("scope.attributes", []),
        "set(span.links, nil)",
        ...spans.map(
          ({ name, shape }) =>
            `${keepKeys("span.attributes", attributeNames(shape))} where span.name == ${ottlString(name)}`,
        ),
        'set(span.status.message, "")',
      ],
    },
    "filter/drop_unregistered_logs": {
      error_mode: "ignore",
      logs: {
        log_record: [
          dropUnlessRegistered(
            "body",
            logs.map(({ name }) => name),
          ),
        ],
      },
    },
    "transform/log_attributes": {
      error_mode: "ignore",
      log_statements: [
        keepKeys("scope.attributes", []),
        ...logs.map(
          ({ name, shape }) =>
            `${keepKeys("log.attributes", attributeNames(shape))} where log.body == ${ottlString(name)}`,
        ),
      ],
    },
    "filter/drop_unregistered_metrics": {
      error_mode: "ignore",
      metrics: { metric: [dropUnlessRegistered("name", metricNames)] },
    },
    "transform/metric_attributes": createMetricAttributesProcessor(metricNames, metricAllowlist),
    "transform/resource_attributes": {
      error_mode: "ignore",
      trace_statements: [keepKeys("resource.attributes", resourceAttributeKeys)],
      log_statements: [keepKeys("resource.attributes", resourceAttributeKeys)],
      metric_statements: [keepKeys("resource.attributes", resourceAttributeKeys)],
    },
  };
}

/** Renders deterministic Collector processors from telemetry registry definitions. */
export function renderCollectorAllowlist(
  spans: readonly CollectorSpanDefinition[],
  logs: readonly CollectorLogDefinition[],
  metricAllowlist: Readonly<Record<string, readonly string[]>>,
): string {
  const sortedSpans = [...spans].sort((left, right) => compareNames(left.name, right.name));
  const sortedLogs = [...logs].sort((left, right) => compareNames(left.name, right.name));
  const metricNames = Object.keys(metricAllowlist).sort(compareNames);
  const processors = createProcessors(sortedSpans, sortedLogs, metricNames, metricAllowlist);
  return [
    "# SPDX-License-Identifier: Apache-2.0",
    "# Generated by scripts/gen-collector-allowlist.ts. Do not edit directly.",
    "# The policy version is derived from this file's SHA-256 (task 10.5).",
    ...renderYamlEntry("processors", processors, 0),
    ...renderYamlEntry("service", { pipelines }, 0),
    "",
  ].join("\n");
}

function createPolicyVersion(allowlist: string): string {
  const digest = createHash("sha256").update(allowlist, "utf8").digest("hex");
  return `p-${digest.slice(0, 12)}`;
}

function renderPolicyVersionYaml(policyVersion: string): string {
  return [
    "# SPDX-License-Identifier: Apache-2.0",
    "# Generated by scripts/gen-collector-allowlist.ts. Do not edit directly.",
    "processors:",
    "  resource/policy_version:",
    "    attributes:",
    "      - key: harness.policy.version",
    `        value: ${JSON.stringify(policyVersion)}`,
    "        action: upsert",
    "",
  ].join("\n");
}

function renderPolicyVersionTypescript(policyVersion: string): string {
  return [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Generated by scripts/gen-collector-allowlist.ts. Do not edit directly.",
    'import { Code } from "@harness/schemas";',
    "",
    `export const POLICY_VERSION = Code.parse(${JSON.stringify(policyVersion)});`,
    "",
  ].join("\n");
}

/** Inputs required to run the Collector allowlist generator. */
export interface CollectorAllowlistCommandOptions {
  readonly allowlistPath: string;
  readonly policyVersionYamlPath: string;
  readonly policyVersionTypescriptPath: string;
  readonly spans: readonly CollectorSpanDefinition[];
  readonly logs: readonly CollectorLogDefinition[];
  readonly metricAllowlist: Readonly<Record<string, readonly string[]>>;
}

/** Exit status and safe diagnostic produced by the Collector allowlist command. */
export interface CollectorAllowlistCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
}

/** Regenerates the allowlist file or checks it for drift. */
export function runCollectorAllowlistCommand(
  args: readonly string[],
  options: CollectorAllowlistCommandOptions,
): CollectorAllowlistCommandResult {
  if (args.length > 1 || args.some((argument) => argument !== "--check")) {
    return { exitCode: 2, stderr: "Usage: yarn gen:collector [--check]\n" };
  }
  const allowlist = renderCollectorAllowlist(options.spans, options.logs, options.metricAllowlist);
  const policyVersion = createPolicyVersion(allowlist);
  const generatedFiles = [
    {
      label: "allowlist.generated.yaml",
      path: options.allowlistPath,
      content: allowlist,
    },
    {
      label: "policy-version.generated.yaml",
      path: options.policyVersionYamlPath,
      content: renderPolicyVersionYaml(policyVersion),
    },
    {
      label: "policy-version.ts",
      path: options.policyVersionTypescriptPath,
      content: renderPolicyVersionTypescript(policyVersion),
    },
  ];
  if (args.includes("--check")) {
    for (const file of generatedFiles) {
      const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : undefined;
      if (existing === file.content) {
        continue;
      }
      const existingLines = (existing ?? "").split("\n");
      const generatedLines = file.content.split("\n");
      const lineCount = Math.max(existingLines.length, generatedLines.length);
      let firstDifferingLine = 1;
      for (let index = 0; index < lineCount; index += 1) {
        if (existingLines[index] !== generatedLines[index]) {
          firstDifferingLine = index + 1;
          break;
        }
      }
      return {
        exitCode: 1,
        stderr: `${file.label} is stale (first differing line: ${String(firstDifferingLine)}). Run \`yarn gen:collector\` and commit the result.\n`,
      };
    }
    return { exitCode: 0, stderr: "" };
  }

  for (const file of generatedFiles) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  return { exitCode: 0, stderr: "" };
}

function isRegistrationSourceModule(value: unknown): value is typeof RegistrationSourceModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "findTelemetryRegistrationSources") === "function"
  );
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const allowlistPath = fileURLToPath(
    new URL("../infra/collector/allowlist.generated.yaml", import.meta.url),
  );
  const policyVersionYamlPath = fileURLToPath(
    new URL("../infra/collector/policy-version.generated.yaml", import.meta.url),
  );
  const policyVersionTypescriptPath = fileURLToPath(
    new URL("../packages/telemetry/src/generated/policy-version.ts", import.meta.url),
  );
  const loadedRegistrationSources: unknown = await import(
    new URL("./telemetry-registration-sources.ts", import.meta.url).href
  );
  if (!isRegistrationSourceModule(loadedRegistrationSources)) {
    throw new Error("Telemetry registration source scanner failed to load.");
  }
  for (const source of loadedRegistrationSources.findTelemetryRegistrationSources(root)) {
    const builtModule = source.replace("/src/", "/dist/").replace(/\.ts$/u, ".js");
    await import(pathToFileURL(`${root}/${builtModule}`).href);
  }
  const result = runCollectorAllowlistCommand(process.argv.slice(2), {
    allowlistPath,
    policyVersionYamlPath,
    policyVersionTypescriptPath,
    spans: listSpanDefinitions(),
    logs: listLogDefinitions(),
    metricAllowlist: METRIC_ALLOWLIST,
  });
  if (result.stderr !== "") {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

const scriptPath = process.argv[1];
if (scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href) {
  await main();
}
