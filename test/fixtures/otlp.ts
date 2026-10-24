// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

type OtlpAttributes = readonly {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}[];

type OtlpPayload = Readonly<Record<string, unknown>>;

/** Derives a run-specific synthetic canary from the supplied seed. */
export function createCanary(seed: string): string {
  return `fixture-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function createTraceFixture(canary: string, resourceAttributes: OtlpAttributes): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: "harness.fixture", version: "1.0.0" },
            spans: [
              {
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
                name: "harness.run",
                kind: 1,
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "2000000000",
                attributes: [{ key: "harness.run.id", value: { stringValue: "run.fixture" } }],
                status: { code: 1 },
              },
              {
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "1123456789abcdef",
                name: "harness.run",
                kind: 1,
                startTimeUnixNano: "2000000000",
                endTimeUnixNano: "3000000000",
                attributes: [
                  { key: "harness.run.id", value: { stringValue: "run.fixture" } },
                  {
                    key: "http.url",
                    value: { stringValue: `https://example.invalid/?token=${canary}` },
                  },
                  { key: "exception.message", value: { stringValue: canary } },
                  { key: "custom.note", value: { stringValue: canary } },
                ],
                events: [
                  {
                    timeUnixNano: "2500000000",
                    name: "exception",
                    attributes: [{ key: "exception.message", value: { stringValue: canary } }],
                  },
                ],
                status: { code: 2, message: `status-${canary}` },
              },
              {
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "2123456789abcdef",
                name: `custom.unregistered.${canary}`,
                kind: 1,
                startTimeUnixNano: "3000000000",
                endTimeUnixNano: "4000000000",
                attributes: [{ key: "custom.note", value: { stringValue: canary } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createLogFixture(canary: string, resourceAttributes: OtlpAttributes): OtlpPayload {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: "harness.fixture", version: "1.0.0" },
            logRecords: [
              {
                timeUnixNano: "1000000000",
                severityNumber: 9,
                body: { stringValue: "harness.safe.run_created" },
                attributes: [
                  {
                    key: "harness.policy.version",
                    value: { stringValue: "fixture.input.version" },
                  },
                  { key: "custom.note", value: { stringValue: canary } },
                ],
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
              },
              {
                timeUnixNano: "2000000000",
                severityNumber: 9,
                body: { stringValue: `free-text-${canary}` },
                attributes: [{ key: "custom.note", value: { stringValue: canary } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createMetricFixture(canary: string, resourceAttributes: OtlpAttributes): OtlpPayload {
  const dataPoint = (value: string, attributes: OtlpAttributes) => ({
    startTimeUnixNano: "1000000000",
    timeUnixNano: "2000000000",
    asInt: value,
    attributes,
  });
  const sum = (dataPoints: ReturnType<typeof dataPoint>[]) => ({
    aggregationTemporality: 2,
    isMonotonic: true,
    dataPoints,
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes },
        scopeMetrics: [
          {
            scope: { name: "harness.fixture", version: "1.0.0" },
            metrics: [
              {
                name: "harness.model.tokens",
                unit: "{token}",
                sum: sum([
                  dataPoint("7", [
                    {
                      key: "harness.model.provider",
                      value: { stringValue: "fixture" },
                    },
                    { key: "custom.note", value: { stringValue: canary } },
                  ]),
                ]),
              },
              {
                name: `custom.unregistered.${canary}`,
                unit: "1",
                sum: sum([
                  dataPoint("1", [{ key: "custom.note", value: { stringValue: canary } }]),
                ]),
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Builds deterministic OTLP/JSON payloads for collector allowlist integration tests. */
export function buildOtlpFixtures(
  canary: string,
): Record<"traces" | "logs" | "metrics", OtlpPayload> {
  const resourceAttributes = [
    { key: "service.name", value: { stringValue: "harness-fixture" } },
    { key: "host.name", value: { stringValue: `host-${canary}` } },
    { key: "process.command_line", value: { stringValue: `command-${canary}` } },
  ];
  return {
    traces: createTraceFixture(canary, resourceAttributes),
    logs: createLogFixture(canary, resourceAttributes),
    metrics: createMetricFixture(canary, resourceAttributes),
  };
}
