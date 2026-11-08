// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryConfigSchema } from "@rovinos/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLICY_VERSION } from "../generated/policy-version.js";
import { assertSinkPolicies } from "./policy.js";

const traceProcessors = [
  "memory_limiter",
  "filter/drop_unregistered_spans",
  "filter/drop_span_events",
  "transform/span_attributes",
  "transform/resource_attributes",
  "resource/policy_version",
  "batch",
];
const logProcessors = [
  "memory_limiter",
  "filter/drop_unregistered_logs",
  "transform/log_attributes",
  "transform/resource_attributes",
  "resource/policy_version",
  "batch",
];
const metricProcessors = [
  "memory_limiter",
  "filter/drop_unregistered_metrics",
  "transform/metric_attributes",
  "transform/resource_attributes",
  "resource/policy_version",
  "batch",
];
const processorNames = [
  ...new Set([...traceProcessors, ...logProcessors, ...metricProcessors]),
];

let temporaryDirectory: string | undefined;

async function createCollectorDirectory(options: {
  readonly traceChain?: readonly string[];
  readonly version?: string;
  readonly profileFile?: string;
  readonly profileContents?: string;
} = {}): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "harness-sink-policy-"));
  const directory = temporaryDirectory;
  await Promise.all([
    writeFile(
      join(directory, "base.yaml"),
      "processors:\n  memory_limiter: {}\n  batch: {}\n",
      "utf8",
    ),
    writeFile(
      join(directory, "allowlist.generated.yaml"),
      [
        "processors:",
        ...processorNames.map((name) => `  ${name}: {}`),
        "service:",
        "  pipelines:",
        "    traces:",
        `      processors: [${(options.traceChain ?? traceProcessors).join(", ")}]`,
        `    logs:\n      processors: [${logProcessors.join(", ")}]`,
        `    metrics:\n      processors: [${metricProcessors.join(", ")}]`,
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      join(directory, "policy-version.generated.yaml"),
      [
        "processors:",
        "  resource/policy_version:",
        "    attributes:",
        "      - key: harness.policy.version",
        `        value: ${options.version ?? POLICY_VERSION}`,
        "        action: upsert",
        "",
      ].join("\n"),
      "utf8",
    ),
    ...(options.profileFile === undefined
      ? []
      : [
          writeFile(
            join(directory, options.profileFile),
            options.profileContents ?? "",
            "utf8",
          ),
        ]),
    ...(options.profileFile === undefined && options.profileContents === undefined
      ? [
          writeFile(
            join(directory, "profile-datadog.yaml"),
            [
              "exporters:",
              "  datadog: {}",
              "service:",
              "  pipelines:",
              "    traces: { exporters: [datadog] }",
              "    logs: { exporters: [datadog] }",
              "    metrics: { exporters: [datadog] }",
              "",
            ].join("\n"),
            "utf8",
          ),
        ]
      : []),
  ]);
  return directory;
}

afterEach(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("assertSinkPolicies", () => {
  it("accepts a configured sink when each matching pipeline uses the generated allowlist chain", async () => {
    const collectorConfigDir = await createCollectorDirectory();
    const config = TelemetryConfigSchema.parse({
      sinks: [{ id: "events", kind: "datadog" }],
    });

    await expect(
      assertSinkPolicies(config, { collectorConfigDir, logger: { info: vi.fn() } }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["kusto", "profile-adx.yaml", "azuredataexplorer", ["traces", "logs", "metrics"]],
    ["datadog", "profile-datadog.yaml", "datadog", ["traces", "logs", "metrics"]],
    ["stdout", "profile-debug.yaml", "debug", ["traces", "logs", "metrics"]],
    ["file", "profile-test.yaml", "file/traces", ["traces"]],
  ] as const)("validates the %s local sink profile", async (kind, file, exporter, pipelines) => {
    const collectorConfigDir = await createCollectorDirectory({
      profileFile: file,
      profileContents: [
        `exporters:\n  ${exporter}: {}`,
        "service:",
        "  pipelines:",
        ...pipelines.map((pipeline) => `    ${pipeline}: { exporters: [${exporter}] }`),
        "",
      ].join("\n"),
    });
    const config = TelemetryConfigSchema.parse({ sinks: [{ id: "local", kind }] });

    await expect(
      assertSinkPolicies(config, { collectorConfigDir, logger: { info: vi.fn() } }),
    ).resolves.toBeUndefined();
  });

  it("rejects a missing allowlist processor and identifies its sink", async () => {
    const collectorConfigDir = await createCollectorDirectory({
      traceChain: traceProcessors.slice(1),
    });
    const config = TelemetryConfigSchema.parse({
      sinks: [{ id: "events", kind: "datadog" }],
    });

    await expect(
      assertSinkPolicies(config, { collectorConfigDir, logger: { info: vi.fn() } }),
    ).rejects.toMatchObject({
      code: "sink_policy_violation",
      sinkId: "events",
    });
  });

  it("rejects an allowlist processor chain in the wrong order", async () => {
    const collectorConfigDir = await createCollectorDirectory({
      traceChain: [...traceProcessors].reverse(),
    });
    const config = TelemetryConfigSchema.parse({
      sinks: [{ id: "events", kind: "datadog" }],
    });

    await expect(
      assertSinkPolicies(config, { collectorConfigDir, logger: { info: vi.fn() } }),
    ).rejects.toMatchObject({ code: "sink_policy_violation", sinkId: "events" });
  });

  it("rejects a missing collector profile", async () => {
    const collectorConfigDir = await createCollectorDirectory();
    await rm(join(collectorConfigDir, "profile-datadog.yaml"));
    const config = TelemetryConfigSchema.parse({
      sinks: [{ id: "events", kind: "datadog" }],
    });

    await expect(
      assertSinkPolicies(config, { collectorConfigDir, logger: { info: vi.fn() } }),
    ).rejects.toMatchObject({ code: "sink_policy_violation", sinkId: "events" });
  });

  it("rejects a collector policy version that differs from the compiled version", async () => {
    const collectorConfigDir = await createCollectorDirectory({ version: "p-000000000000" });
    const config = TelemetryConfigSchema.parse({
      sinks: [{ id: "events", kind: "datadog" }],
    });

    await expect(
      assertSinkPolicies(config, { collectorConfigDir, logger: { info: vi.fn() } }),
    ).rejects.toMatchObject({ code: "sink_policy_version_mismatch" });
  });

  it("rejects content-capable sinks without unsafe opt-in and logs when opted in", async () => {
    const collectorConfigDir = await createCollectorDirectory();
    const unsafeSink = { id: "events", kind: "datadog", maxClassification: "content_tokenized" };
    const logger = { info: vi.fn() };

    await expect(
      assertSinkPolicies(
        TelemetryConfigSchema.parse({ sinks: [unsafeSink] }),
        { collectorConfigDir, logger },
      ),
    ).rejects.toMatchObject({
      code: "content_sink_forbidden",
      sinkId: "events",
    });

    await expect(
      assertSinkPolicies(
        TelemetryConfigSchema.parse({
          sinks: [unsafeSink],
          unsafe: { allowContentSinks: true },
        }),
        { collectorConfigDir, logger },
      ),
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith("telemetry_content_sink_enabled", {
      sink_id: "events",
    });
  });

  it("does not load collector files when no sinks are enabled", async () => {
    const config = TelemetryConfigSchema.parse({});

    await expect(
      assertSinkPolicies(config, { collectorConfigDir: "/missing", logger: { info: vi.fn() } }),
    ).resolves.toBeUndefined();
  });
});
