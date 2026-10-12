// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import { z } from "zod";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const yamlSchema = z.record(z.string(), z.unknown());

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
    "infra/collector/profile-debug.yaml",
    "infra/compose/docker-compose.yml",
    "infra/compose/docker-compose.test.yml",
  ]) {
    expect(containsLiteralSecrets(readYaml(path))).toBe(false);
  }
});

it("does not publish a wildcard-bound port in Compose profiles", () => {
  for (const path of [
    "infra/compose/docker-compose.yml",
    "infra/compose/docker-compose.test.yml",
  ]) {
    const compose = readYaml(path);
    const services = compose.services;
    expect(isRecord(services)).toBe(true);
    if (!isRecord(services)) {
      continue;
    }
    expect(
      isRecord(services["otel-collector"]) ? services["otel-collector"].ports : undefined,
    ).toBe(undefined);

    for (const service of Object.values(services)) {
      if (!isRecord(service) || !Array.isArray(service.ports)) {
        continue;
      }
      for (const port of service.ports) {
        expect(typeof port === "string" ? port : JSON.stringify(port)).not.toMatch(/^0\.0\.0\.0:/u);
      }
    }
  }
});

it("sets the receiver, processors, health endpoint, and debug pipelines", () => {
  const base = readYaml("infra/collector/base.yaml");
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
  expect(profile.service).toMatchObject({
    pipelines: {
      traces: {
        receivers: ["otlp"],
        processors: ["memory_limiter", "batch"],
        exporters: ["debug"],
      },
      logs: { receivers: ["otlp"], processors: ["memory_limiter", "batch"], exporters: ["debug"] },
      metrics: {
        receivers: ["otlp"],
        processors: ["memory_limiter", "batch"],
        exporters: ["debug"],
      },
    },
  });
});
