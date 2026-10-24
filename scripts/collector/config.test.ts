// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_VERSION } from "@harness/telemetry";
import { expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const yamlSchema = z.record(z.string(), z.unknown());
const composeFiles = [
  "infra/compose/docker-compose.yml",
  "infra/compose/docker-compose.dev.yml",
  "infra/compose/docker-compose.test.yml",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readYaml(path: string): Record<string, unknown> {
  return parseYaml(yamlSchema, readFileSync(resolve(root, path), "utf8"));
}

function containsLiteralSecrets(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsLiteralSecrets);
  }
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(
    ([key, nested]) =>
      (/^(?:api[_-]?key|key|application_key|client_secret|password)$/iu.test(key) &&
        nested !== "harness.policy.version" &&
        !(typeof nested === "string" && nested.startsWith("${env:"))) ||
      containsLiteralSecrets(nested),
  );
}

it("detects literal exporter credentials but permits environment substitutions", () => {
  expect(containsLiteralSecrets({ api: { key: "synthetic-secret" } })).toBe(true);
  expect(containsLiteralSecrets({ api: { key: "${env:DD_API_KEY}" } })).toBe(false);
  expect(
    containsLiteralSecrets({ azuredataexplorer: { application_key: "synthetic-secret" } }),
  ).toBe(true);
});

it("keeps collector and Compose YAML free of literal credentials", () => {
  for (const path of [
    "infra/collector/base.yaml",
    "infra/collector/allowlist.generated.yaml",
    "infra/collector/policy-version.generated.yaml",
    "infra/collector/builder.yaml",
    "infra/collector/profile-debug.yaml",
    "infra/collector/profile-datadog.yaml",
    "infra/collector/profile-adx.yaml",
    "infra/collector/profile-test.yaml",
    ...composeFiles,
  ]) {
    expect(containsLiteralSecrets(readYaml(path))).toBe(false);
  }
});

function hasLoopbackPortBinding(port: unknown): boolean {
  if (typeof port === "string") {
    return /^(?:127\.0\.0\.1|\[::1\]|::1):/u.test(port);
  }
  return (
    isRecord(port) &&
    (port.host_ip === "127.0.0.1" || port.host_ip === "::1" || port.host_ip === "[::1]")
  );
}

it("binds every published Compose port to loopback", () => {
  expect(hasLoopbackPortBinding("4318:4318")).toBe(false);
  for (const path of composeFiles) {
    const compose = readYaml(path);
    const services = compose.services;
    expect(isRecord(services)).toBe(true);
    if (!isRecord(services)) {
      continue;
    }
    for (const service of Object.values(services)) {
      if (!isRecord(service) || !Array.isArray(service.ports)) {
        continue;
      }
      for (const port of service.ports) {
        expect(hasLoopbackPortBinding(port)).toBe(true);
      }
    }
  }
});

it("sets the receiver, processors, health endpoint, and debug pipelines", () => {
  const base = readYaml("infra/collector/base.yaml");
  const allowlist = readYaml("infra/collector/allowlist.generated.yaml");
  const policyVersion = readYaml("infra/collector/policy-version.generated.yaml");
  const profile = readYaml("infra/collector/profile-debug.yaml");

  expect(base.receivers).toMatchObject({
    otlp: {
      protocols: {
        grpc: { endpoint: "0.0.0.0:4317" },
        http: { endpoint: "0.0.0.0:4318" },
      },
    },
  });
  expect(base.processors).toMatchObject({
    memory_limiter: { check_interval: "1s", limit_mib: 256, spike_limit_mib: 64 },
    batch: { timeout: "5s", send_batch_size: 512 },
  });
  expect(readYaml("infra/compose/docker-compose.yml").services).toMatchObject({
    "otel-collector": { mem_limit: "512m", pids_limit: 256 },
  });
  expect(readYaml("infra/compose/docker-compose.dev.yml").services).toMatchObject({
    "otel-collector": {
      profiles: ["dev"],
      ports: ["127.0.0.1:4318:4318", "127.0.0.1::13133"],
    },
  });
  expect(base.extensions).toMatchObject({
    health_check: { endpoint: "0.0.0.0:13133" },
  });
  expect(base.service).toMatchObject({
    telemetry: {
      metrics: {
        level: "basic",
        readers: [
          {
            pull: {
              exporter: {
                prometheus: { host: "0.0.0.0", port: 8888 },
              },
            },
          },
        ],
      },
    },
  });
  expect(profile.exporters).toMatchObject({ debug: { verbosity: "basic" } });
  const processors = yamlSchema.parse(allowlist.processors);
  expect(allowlist.processors).toMatchObject({
    "filter/drop_unregistered_spans": { error_mode: "ignore" },
    "filter/drop_span_events": { error_mode: "ignore" },
    "transform/span_attributes": { error_mode: "ignore" },
    "filter/drop_unregistered_logs": { error_mode: "ignore" },
    "transform/log_attributes": { error_mode: "ignore" },
    "filter/drop_unregistered_metrics": { error_mode: "ignore" },
    "transform/metric_attributes": { error_mode: "ignore" },
    "transform/resource_attributes": { error_mode: "ignore" },
  });
  expect(policyVersion.processors).toMatchObject({
    "resource/policy_version": {
      attributes: [
        {
          key: "harness.policy.version",
          value: POLICY_VERSION,
          action: "upsert",
        },
      ],
    },
  });
  const spanAttributes = yamlSchema.parse(processors["transform/span_attributes"]);
  expect(z.array(z.string()).parse(spanAttributes.trace_statements)).toEqual(
    expect.arrayContaining(["keep_keys(scope.attributes, [])", "set(span.links, nil)"]),
  );
  const logAttributes = yamlSchema.parse(processors["transform/log_attributes"]);
  expect(z.array(z.string()).parse(logAttributes.log_statements)).toEqual(
    expect.arrayContaining(["keep_keys(scope.attributes, [])"]),
  );
  const metricAttributes = yamlSchema.parse(processors["transform/metric_attributes"]);
  expect(z.array(z.string()).parse(metricAttributes.metric_statements)).toEqual(
    expect.arrayContaining([
      "keep_keys(scope.attributes, [])",
      "keep_keys(exemplar.filtered_attributes, [])",
      'keep_keys(datapoint.attributes, ["harness.host.app_rejected.reason"]) where metric.name == "harness.host.app_rejected"',
      'keep_keys(datapoint.attributes, ["harness.telemetry.dropped.reason"]) where metric.name == "harness.telemetry.dropped"',
    ]),
  );
  expect(allowlist.service).toMatchObject({
    pipelines: {
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
    },
  });
  expect(profile.service).toMatchObject({
    pipelines: {
      traces: {
        receivers: ["otlp"],
        exporters: ["debug"],
      },
      logs: {
        receivers: ["otlp"],
        exporters: ["debug"],
      },
      metrics: {
        receivers: ["otlp"],
        exporters: ["debug"],
      },
    },
  });
  expect(profile).not.toHaveProperty("service.pipelines.traces.processors");
  expect(profile).not.toHaveProperty("service.pipelines.logs.processors");
  expect(profile).not.toHaveProperty("service.pipelines.metrics.processors");
});

it("does not publish collector self-metrics outside the internal network", () => {
  for (const path of composeFiles) {
    const services = readYaml(path).services;
    if (!isRecord(services) || !isRecord(services["otel-collector"])) {
      continue;
    }
    const ports = services["otel-collector"].ports;
    expect(Array.isArray(ports) ? ports : []).not.toContainEqual(
      expect.stringMatching(/(?:^|:)8888(?::|$)/u),
    );
  }
});

it("places the policy-version processor last before batch in every profile pipeline", () => {
  const allowlistPipelines = yamlSchema.parse(
    yamlSchema.parse(readYaml("infra/collector/allowlist.generated.yaml").service).pipelines,
  );
  const profiles = readdirSync(resolve(root, "infra/collector")).filter((filename) =>
    /^profile-.*\.yaml$/u.test(filename),
  );

  expect(profiles.length).toBeGreaterThan(0);
  for (const filename of profiles) {
    const profilePipelines = yamlSchema.parse(
      yamlSchema.parse(readYaml(`infra/collector/${filename}`).service).pipelines,
    );
    for (const signal of ["traces", "logs", "metrics"] as const) {
      const profilePipeline = yamlSchema.parse(profilePipelines[signal]);
      const configuredProcessors = profilePipeline.processors;
      const processors =
        configuredProcessors === undefined
          ? z.array(z.string()).parse(yamlSchema.parse(allowlistPipelines[signal]).processors)
          : z.array(z.string()).parse(configuredProcessors);
      expect(processors.slice(-2)).toEqual(["resource/policy_version", "batch"]);
    }
  }
});

it("uses the generated allowlist processor order in every collector profile", () => {
  const allowlist = readYaml("infra/collector/allowlist.generated.yaml");
  const generatedPipelines = yamlSchema.parse(yamlSchema.parse(allowlist.service).pipelines);
  const profileExpectations = [
    {
      path: "infra/collector/profile-debug.yaml",
      exporters: { traces: ["debug"], logs: ["debug"], metrics: ["debug"] },
    },
    {
      path: "infra/collector/profile-datadog.yaml",
      exporters: { traces: ["datadog"], logs: ["datadog"], metrics: ["datadog"] },
    },
    {
      path: "infra/collector/profile-adx.yaml",
      exporters: {
        traces: ["azuredataexplorer"],
        logs: ["azuredataexplorer"],
        metrics: ["azuredataexplorer"],
      },
    },
    {
      path: "infra/collector/profile-test.yaml",
      exporters: {
        traces: ["file/traces"],
        logs: ["file/logs"],
        metrics: ["file/metrics"],
      },
    },
  ] as const;
  const expectedProcessors = {
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

  for (const { path, exporters } of profileExpectations) {
    const profile = readYaml(path);
    const pipelines = yamlSchema.parse(yamlSchema.parse(profile.service).pipelines);

    for (const signal of ["traces", "logs", "metrics"] as const) {
      const pipeline = yamlSchema.parse(pipelines[signal]);
      const generatedPipeline = yamlSchema.parse(generatedPipelines[signal]);

      expect(pipeline.receivers).toEqual(["otlp"]);
      expect(pipeline.exporters).toEqual(exporters[signal]);
      expect(pipeline).not.toHaveProperty("processors");
      expect(generatedPipeline.processors).toEqual(expectedProcessors[signal]);
    }
  }
});

it("writes file exporter output as JSON lines for each signal", () => {
  const profile = readYaml("infra/collector/profile-test.yaml");
  expect(profile.exporters).toMatchObject({
    "file/traces": {
      path: "/var/otel-out/traces.jsonl",
      format: "json",
      append: true,
      create_directory: true,
    },
    "file/logs": {
      path: "/var/otel-out/logs.jsonl",
      format: "json",
      append: true,
      create_directory: true,
    },
    "file/metrics": {
      path: "/var/otel-out/metrics.jsonl",
      format: "json",
      append: true,
      create_directory: true,
    },
  });
});
