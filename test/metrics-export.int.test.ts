// SPDX-License-Identifier: Apache-2.0
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { env } from "node:process";
import { Command } from "commander";
import { HarnessConfigSchema } from "@rovinos/config";
import { createDefaultContext, createOutput, ExitCode, main } from "@rovinos/cli/programmatic";
import { createRuntime, type ModelPort } from "@rovinos/core";
import { createHarness } from "@rovinos/sdk";
import { Code } from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { countModelUsage, recordWorkerQueueLag } from "@rovinos/telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";

function createMetricModel(): ModelPort {
  return {
    complete: () => {
      countModelUsage({ inputTokens: 2, outputTokens: 3 }, "synthetic", "synthetic");
      recordWorkerQueueLag(17);
      return Promise.resolve({
        provider: Code.parse("synthetic"),
        model: Code.parse("synthetic"),
        parts: [{ type: "text", text: "synthetic result" }],
        usage: { inputTokens: 2, outputTokens: 3 },
        finishReason: "stop",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        providerBlobs: null,
      });
    },
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

describe("SDK and CLI OTLP metrics export", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports model counters and worker histograms without prompt content", async () => {
    const requestBodies: Buffer[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", () => {
        requestBodies.push(Buffer.concat(chunks));
        response.writeHead(200, { "content-type": "application/x-protobuf" });
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("metrics_receiver_unavailable");
    }
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", undefined);
    vi.stubEnv(
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      `http://127.0.0.1:${address.port}/v1/metrics`,
    );

    const canary = "SYNTHETIC_METRIC_PROMPT_CANARY";
    const config = HarnessConfigSchema.parse({ pii: { enabled: false } });
    const harness = await createHarness({
      config,
      overrides: { store: new InMemoryEventStore(), transientVault: true, model: createMetricModel() },
    });
    const directory = await mkdtemp(join(tmpdir(), "harness-metrics-cli-"));
    let harnessClosed = false;
    try {
      await harness.startRun({ goal: canary });
      await harness.close();
      harnessClosed = true;

      const inputPath = join(directory, "input.json");
      await writeFile(inputPath, JSON.stringify({ goal: canary }), "utf8");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const context = createDefaultContext(
        new Command(),
        createOutput({
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        }),
      );
      context.loadConfig = () => Promise.resolve(config);
      context.createRuntime = (runtimeConfig, overrides) =>
        createRuntime(runtimeConfig, {
          ...overrides,
          store: new InMemoryEventStore(),
          transientVault: true,
          model: createMetricModel(),
        });

      expect(await main(["run", "--input", inputPath], context)).toBe(ExitCode.ok);
      expect(stderr.join("")).toBe("");
      expect(stdout.join("")).not.toContain(canary);

      expect(requestBodies.length).toBeGreaterThanOrEqual(2);
      const metricPayloads = requestBodies.map((body) => body.toString("latin1"));
      expect(metricPayloads.some((payload) => payload.includes("harness.model.tokens"))).toBe(true);
      expect(
        metricPayloads.some((payload) => payload.includes("harness.worker.queue_lag_ms")),
      ).toBe(true);
      for (const body of requestBodies) {
        expect(body.includes(Buffer.from(canary))).toBe(false);
        expect(body.includes(Buffer.from("cli.local"))).toBe(false);
      }
    } finally {
      if (!harnessClosed) {
        await harness.close();
      }
      await rm(directory, { recursive: true, force: true });
      await closeServer(server);
    }
  });
});
