// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
      (/^(?:api_key|password)$/iu.test(key) &&
        !(typeof nested === "string" && nested.startsWith("${env:"))) ||
      containsLiteralSecrets(nested),
  );
}

it("keeps collector and Compose YAML free of literal credentials", () => {
  for (const path of [
    "infra/collector/base.yaml",
    "infra/collector/allowlist.generated.yaml",
    "infra/collector/profile-debug.yaml",
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
    "otel-collector-dev": {
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
  expect(profile.service).toMatchObject({
    pipelines: {
      traces: {
        receivers: ["otlp"],
        processors: [
          "memory_limiter",
          "filter/drop_unregistered_spans",
          "filter/drop_span_events",
          "transform/span_attributes",
          "transform/resource_attributes",
          "batch",
        ],
        exporters: ["debug"],
      },
      logs: {
        receivers: ["otlp"],
        processors: [
          "memory_limiter",
          "filter/drop_unregistered_logs",
          "transform/log_attributes",
          "transform/resource_attributes",
          "batch",
        ],
        exporters: ["debug"],
      },
      metrics: {
        receivers: ["otlp"],
        processors: [
          "memory_limiter",
          "filter/drop_unregistered_metrics",
          "transform/metric_attributes",
          "transform/resource_attributes",
          "batch",
        ],
        exporters: ["debug"],
      },
    },
  });
});
