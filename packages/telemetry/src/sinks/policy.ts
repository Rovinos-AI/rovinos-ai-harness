// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Code,
  HarnessError,
  parseYaml,
  TelemetryConfigSchema,
  type SinkPolicy,
  type TelemetryConfig,
} from "@rovinos/schemas";
import { z } from "zod";
import { createLogger, type Logger } from "../logger.js";
import { POLICY_VERSION } from "../generated/policy-version.js";

const CollectorPipelineSchema = z
  .object({
    exporters: z.array(z.string()).optional(),
    processors: z.array(z.string()).optional(),
  })
  .loose();

const CollectorConfigSchema = z
  .object({
    exporters: z.record(z.string(), z.unknown()).optional(),
    processors: z.record(z.string(), z.unknown()).optional(),
    service: z
      .object({
        pipelines: z.record(z.string(), CollectorPipelineSchema).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const PolicyVersionConfigSchema = z
  .object({
    processors: z.record(
      z.string(),
      z
        .object({
          attributes: z.array(
            z
              .object({
                key: z.string(),
                value: Code,
                action: z.string(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

const PROCESSORS_BY_PIPELINE: Readonly<Record<string, readonly string[]>> = {
  traces: [
    "memory_limiter",
    "filter/drop_unregistered_spans",
    "filter/drop_span_events",
    "transform/span_attributes",
    "transform/resource_attributes",
    "resource/policy_version",
    "batch",
  ],
  logs: [
    "memory_limiter",
    "filter/drop_unregistered_logs",
    "transform/log_attributes",
    "transform/resource_attributes",
    "resource/policy_version",
    "batch",
  ],
  metrics: [
    "memory_limiter",
    "filter/drop_unregistered_metrics",
    "transform/metric_attributes",
    "transform/resource_attributes",
    "resource/policy_version",
    "batch",
  ],
};

const PROFILE_BY_KIND: Readonly<
  Record<SinkPolicy["kind"], { readonly file: string; readonly exporter: string }>
> = {
  datadog: { file: "profile-datadog.yaml", exporter: "datadog" },
  kusto: { file: "profile-adx.yaml", exporter: "azuredataexplorer" },
  stdout: { file: "profile-debug.yaml", exporter: "debug" },
  file: { file: "profile-test.yaml", exporter: "file/" },
};

/** Stable, value-safe policy validation error. */
export class SinkPolicyError extends HarnessError {
  override readonly code:
    "sink_policy_violation" | "sink_policy_version_mismatch" | "content_sink_forbidden";
  readonly sinkId: SinkPolicy["id"] | undefined;

  constructor(code: SinkPolicyError["code"], sinkId?: SinkPolicy["id"]) {
    super(sinkId === undefined ? code : `${code}: ${sinkId}`);
    this.code = code;
    this.sinkId = sinkId;
  }
}

/** Options for validating sink policies against the deployed Collector configuration. */
export interface AssertSinkPoliciesOptions {
  /** Directory containing the base, generated allowlist, generated version, and profiles. */
  readonly collectorConfigDir: string;
  /** Structured logger used when an unsafe content-capable sink is enabled. */
  readonly logger?: Pick<Logger, "info">;
}

/** Validated full harness configuration or its telemetry section. */
export type SinkPolicyConfig = TelemetryConfig | { readonly telemetry?: TelemetryConfig };

async function readCollectorConfig<Schema extends z.ZodType>(
  directory: string,
  file: string,
  schema: Schema,
  sinkId?: SinkPolicy["id"],
): Promise<z.infer<Schema>> {
  try {
    const contents = await readFile(join(directory, file), { encoding: "utf8" });
    return parseYaml(schema, contents);
  } catch {
    throw new SinkPolicyError("sink_policy_violation", sinkId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExpectedProcessors(
  pipelineName: string,
  actual: readonly string[] | undefined,
  definitions: ReadonlySet<string>,
): boolean {
  const expected = PROCESSORS_BY_PIPELINE[pipelineName];
  return (
    expected !== undefined &&
    actual?.length === expected.length &&
    actual.every((processor, index) => processor === expected[index] && definitions.has(processor))
  );
}

function matchesExporter(exporters: readonly string[], expected: string): boolean {
  return exporters.some((exporter) =>
    expected.endsWith("/") ? exporter.startsWith(expected) : exporter === expected,
  );
}

function reportUnsafeSink(sink: SinkPolicy, logger: Pick<Logger, "info">): void {
  logger.info(Code.parse("telemetry_content_sink_enabled"), { sink_id: sink.id });
}

interface CollectorPolicy {
  readonly processorDefinitions: ReadonlySet<string>;
  readonly pipelines: Record<string, z.infer<typeof CollectorPipelineSchema>> | undefined;
}

async function loadCollectorPolicy(directory: string): Promise<CollectorPolicy> {
  const [base, allowlist, versionConfig] = await Promise.all([
    readCollectorConfig(directory, "base.yaml", CollectorConfigSchema),
    readCollectorConfig(directory, "allowlist.generated.yaml", CollectorConfigSchema),
    readCollectorConfig(directory, "policy-version.generated.yaml", PolicyVersionConfigSchema),
  ]);
  const versionAttributes = versionConfig.processors["resource/policy_version"]?.attributes;
  if (
    versionAttributes?.some(
      ({ key, value, action }) =>
        key === "harness.policy.version" && value === POLICY_VERSION && action === "upsert",
    ) !== true
  ) {
    throw new SinkPolicyError("sink_policy_version_mismatch");
  }
  return {
    processorDefinitions: new Set([
      ...Object.keys(base.processors ?? {}),
      ...Object.keys(allowlist.processors ?? {}),
      ...Object.keys(versionConfig.processors),
    ]),
    pipelines: allowlist.service?.pipelines,
  };
}

function assertProfilePipelines(
  sink: SinkPolicy,
  profile: (typeof PROFILE_BY_KIND)[SinkPolicy["kind"]],
  collectorProfile: z.infer<typeof CollectorConfigSchema>,
  collectorPolicy: CollectorPolicy,
): void {
  const exporters = collectorProfile.exporters;
  const pipelines = collectorProfile.service?.pipelines;
  if (
    !isRecord(exporters) ||
    !Object.keys(exporters).some((exporter) => matchesExporter([exporter], profile.exporter)) ||
    pipelines === undefined
  ) {
    throw new SinkPolicyError("sink_policy_violation", sink.id);
  }

  const matchingPipelines = Object.entries(pipelines).filter(([, pipeline]) =>
    matchesExporter(pipeline.exporters ?? [], profile.exporter),
  );
  if (matchingPipelines.length === 0) {
    throw new SinkPolicyError("sink_policy_violation", sink.id);
  }
  for (const [pipelineName, pipeline] of matchingPipelines) {
    if (
      !hasExpectedProcessors(
        pipelineName,
        collectorPolicy.pipelines?.[pipelineName]?.processors,
        collectorPolicy.processorDefinitions,
      ) ||
      (pipeline.processors !== undefined &&
        !hasExpectedProcessors(
          pipelineName,
          pipeline.processors,
          collectorPolicy.processorDefinitions,
        ))
    ) {
      throw new SinkPolicyError("sink_policy_violation", sink.id);
    }
  }
}

async function assertSinkProfile(
  sink: SinkPolicy,
  directory: string,
  collectorPolicy: CollectorPolicy,
): Promise<void> {
  const profile = PROFILE_BY_KIND[sink.kind];
  const collectorProfile = await readCollectorConfig(
    directory,
    profile.file,
    CollectorConfigSchema,
    sink.id,
  );
  assertProfilePipelines(sink, profile, collectorProfile, collectorPolicy);
}

/**
 * Verifies enabled sink policies against the collector's exporter profiles and generated
 * allowlist. Content-capable sinks additionally require the explicit unsafe opt-in.
 *
 * @param config - Validated harness configuration or telemetry configuration.
 * @param options - Collector config location and optional structured logger.
 * @throws SinkPolicyError when a sink is unsafe or its collector pipeline is not compliant.
 */
export async function assertSinkPolicies(
  config: SinkPolicyConfig,
  options: AssertSinkPoliciesOptions,
): Promise<void> {
  const telemetry =
    "sinks" in config ? config : (config.telemetry ?? TelemetryConfigSchema.parse({}));
  const sinks = telemetry.sinks.filter(({ enabled }) => enabled);
  const unsafeSinks = sinks.filter(
    ({ maxClassification }) => maxClassification === "content_tokenized",
  );
  const firstUnsafeSink = unsafeSinks.at(0);
  if (!telemetry.unsafe.allowContentSinks && firstUnsafeSink !== undefined) {
    throw new SinkPolicyError("content_sink_forbidden", firstUnsafeSink.id);
  }
  if (sinks.length === 0) {
    return;
  }

  const collectorPolicy = await loadCollectorPolicy(options.collectorConfigDir);
  const logger = options.logger ?? createLogger();

  for (const sink of sinks) {
    await assertSinkProfile(sink, options.collectorConfigDir, collectorPolicy);
    if (sink.maxClassification === "content_tokenized") {
      reportUnsafeSink(sink, logger);
    }
  }
}
