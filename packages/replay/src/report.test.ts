// SPDX-License-Identifier: Apache-2.0
import { Code, Event, Id } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { diffRuns } from "./diff.js";
import {
  assertBaselineUpdateAllowed,
  compareGoldenSignature,
  createGoldenSignature,
  createReplayReport,
  GoldenSignatureSchema,
  renderGoldenSignatureJson,
  renderReplayReportJson,
  renderReplayReportText,
  ReplayReportSchema,
  replayReportExitCode,
} from "./report.js";
import { ReplayOutcomeSchema } from "./replay.js";

const originalRunId = Id.parse("00000000000000000000000001");
const replayRunId = Id.parse("00000000000000000000000002");
const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const contentCanary = "REPLAY_REPORT_CONTENT_MUST_NOT_BE_PRINTED";

function events(configHash = "a".repeat(64)) {
  return [
    Event.parse({
      runId: originalRunId,
      seq: 0,
      ts: 1,
      v: 1,
      traceId,
      spanId,
      segmentId: originalRunId,
      type: "run_created",
      configHash,
      policyVersion: "synthetic.policy",
      depth: 0,
    }),
    Event.parse({
      runId: originalRunId,
      seq: 1,
      ts: 2,
      v: 1,
      traceId,
      spanId,
      segmentId: originalRunId,
      type: "run_input",
      input: contentCanary,
      inputKind: "initial",
    }),
  ];
}

function reportFor(
  diff = diffRuns(events(), events()),
  options: {
    status?: "completed" | "error";
    divergence?: { seq: number; code: "replay_divergence" | "replay_missing_result" };
  } = {},
) {
  const outcome = ReplayOutcomeSchema.parse({
    replayRunId,
    traceId,
    status: options.status ?? "completed",
    events: events(),
    configDrift: false,
    policyDrift: false,
    ...(options.divergence === undefined ? {} : { divergence: options.divergence }),
  });
  return createReplayReport({ originalRunId, outcome, diff });
}

describe("replay reports and golden signatures", () => {
  it("validates strict reports and rejects content-classified data", () => {
    const report = reportFor();

    expect(ReplayReportSchema.parse(report)).toEqual(report);
    expect(() => ReplayReportSchema.parse({ ...report, unexpected: true })).toThrow();
    expect(() =>
      ReplayReportSchema.parse({
        ...report,
        entries: [
          {
            kind: "changed",
            index: 0,
            eventKind: Code.parse("run_created"),
            fields: [
              {
                field: Code.parse("provider"),
                a: contentCanary,
                b: "synthetic",
              },
            ],
            class: "behavioral",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      GoldenSignatureSchema.parse({
        schemaVersion: 1,
        containsRealData: false,
        signature: [{ kind: "run_created", content: contentCanary }],
      }),
    ).toThrow();
  });

  it("maps behavioral, noise-only, strict, and divergence outcomes to exit codes", () => {
    const behavioral = reportFor(diffRuns(events(), events("b".repeat(64))));
    const noise = reportFor({
      identical: true,
      summary: { added: 0, removed: 0, changed: 1, behavioral: 0, noise: 1 },
      entries: [],
      approximate: false,
    });
    const failed = reportFor(diffRuns(events(), events()), {
      status: "error",
      divergence: { seq: 3, code: "replay_divergence" },
    });

    expect(replayReportExitCode(reportFor())).toBe(0);
    expect(replayReportExitCode(noise)).toBe(0);
    expect(replayReportExitCode(noise, true)).toBe(1);
    expect(replayReportExitCode(behavioral)).toBe(1);
    expect(replayReportExitCode(failed)).toBe(8);
  });

  it("compares golden signatures and preserves noise-aware diff classification", () => {
    const baseline = createGoldenSignature(events());
    const same = compareGoldenSignature(events(), baseline);
    const changed = compareGoldenSignature(events("b".repeat(64)), baseline);

    expect(same.match).toBe(true);
    expect(same.diff.summary.behavioral).toBe(0);
    expect(changed.match).toBe(false);
    expect(changed.diff.summary.behavioral).toBeGreaterThan(0);
    expect(GoldenSignatureSchema.parse(baseline).containsRealData).toBe(false);
  });

  it("permits explicit safe baseline updates and refuses divergence or CI updates", () => {
    expect(() => {
      assertBaselineUpdateAllowed({ inCi: false, forceInCi: false });
    }).not.toThrow();
    expect(() => {
      assertBaselineUpdateAllowed({
        divergence: { seq: 3, code: "replay_divergence" },
        inCi: false,
        forceInCi: false,
      });
    }).toThrow();
    expect(() => {
      assertBaselineUpdateAllowed({ inCi: true, forceInCi: false });
    }).toThrow();
    expect(() => {
      assertBaselineUpdateAllowed({ inCi: true, forceInCi: true });
    }).not.toThrow();
    expect(renderGoldenSignatureJson(createGoldenSignature(events()))).toContain(
      '"containsRealData": false',
    );
  });

  it("renders deterministic JSON and only the first 50 text entries without content", () => {
    const base = reportFor();
    const entries = Array.from({ length: 51 }, (_, index) => ({
      kind: "added" as const,
      index,
      eventKind: Code.parse("run_created"),
      class: "behavioral" as const,
    }));
    const report = ReplayReportSchema.parse({
      ...base,
      entries,
      summary: { added: 51, removed: 0, changed: 0, behavioral: 51, noise: 0 },
    });
    const json = renderReplayReportJson(report);
    const text = renderReplayReportText(report);

    expect(json).toBe(renderReplayReportJson(report));
    expect(json.indexOf('"approximate"')).toBeLessThan(json.indexOf('"configDrift"'));
    expect(text.match(/added run_created at /gu)).toHaveLength(50);
    expect(text).toContain("1 additional entries omitted");
    expect(`${json}${text}`).not.toContain(contentCanary);
  });
});
