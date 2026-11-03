// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CassetteFileSchema, FileCassetteStore, requestHash } from "@rovinos/models";
import {
  compareGoldenSignature,
  createReplayReport,
  GoldenSignatureSchema,
  replayReportExitCode,
  replayRun,
} from "@rovinos/replay";
import { parseJson } from "@rovinos/schemas";
import { verifyInvariants } from "@rovinos/eval";
import { runReplayGolden } from "../../scripts/replay-golden.js";
import { recordGoldenScenario, withGoldenTracing } from "./golden/scenario.js";

const goldenDirectory = join(import.meta.dirname, "golden");
const signaturePath = join(goldenDirectory, "signature.json");
const cassettePath = join(goldenDirectory, "cassette.json");

async function loadSignature() {
  return parseJson(GoldenSignatureSchema, await readFile(signaturePath, "utf8"));
}

it("replays the scripted golden run without divergence or behavioral differences", async () => {
  await withGoldenTracing(async () => {
    const scenario = await recordGoldenScenario();
    const outcome = await replayRun(scenario.resolved, {
      config: scenario.config,
      policy: scenario.policy,
    });
    const comparison = compareGoldenSignature(
      [...outcome.events, ...scenario.coverageEvents],
      await loadSignature(),
    );
    const report = createReplayReport({
      originalRunId: scenario.resolved.rootRunId,
      outcome,
      diff: comparison.diff,
      goldenMatch: comparison.match,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.divergence).toBeUndefined();
    expect(comparison.match).toBe(true);
    expect(replayReportExitCode(report)).toBe(0);
    const recordedEvents = scenario.resolved.runs[0]?.events ?? [];
    expect(verifyInvariants(recordedEvents)).toEqual([]);
    expect(verifyInvariants(outcome.events)).toEqual([]);
    expect(scenario.crashResumed).toBe(true);
    expect(scenario.coverageEvents.some((event) => event.type === "context_compacted")).toBe(true);
    expect(recordedEvents.some((event) => event.type === "checkpoint_written")).toBe(true);
    expect(
      recordedEvents.some(
        (event) => event.type === "approval_resolved" && event.decision === "edit",
      ),
    ).toBe(true);
    expect(recordedEvents.some((event) => event.type === "tool_intent" && event.idempotent)).toBe(
      true,
    );
    expect(recordedEvents.some((event) => event.type === "tool_intent" && !event.idempotent)).toBe(
      true,
    );
    expect(
      recordedEvents.some(
        (event) => event.type === "tool_intent" && event.policyDecision === "deny",
      ),
    ).toBe(true);
  });
});

it("fails the regression gate when the scripted tool-call order changes", async () => {
  await withGoldenTracing(async () => {
    const scenario = await recordGoldenScenario(true);
    const outcome = await replayRun(scenario.resolved, {
      config: scenario.config,
      policy: scenario.policy,
    });
    const comparison = compareGoldenSignature(
      [...outcome.events, ...scenario.coverageEvents],
      await loadSignature(),
    );
    const report = createReplayReport({
      originalRunId: scenario.resolved.rootRunId,
      outcome,
      diff: comparison.diff,
      goldenMatch: comparison.match,
    });

    expect(outcome.status).toBe("completed");
    expect(replayReportExitCode(report)).toBe(1);
    expect(comparison.diff.summary.behavioral).toBeGreaterThan(0);
  });
});

it("loads synthetic cassette and signature fixtures without canary patterns", async () => {
  const cassetteText = await readFile(cassettePath, "utf8");
  const signatureText = await readFile(signaturePath, "utf8");
  const cassette = parseJson(CassetteFileSchema, cassetteText);
  const signature = parseJson(GoldenSignatureSchema, signatureText);

  expect(cassette.containsRealData).toBe(false);
  expect(signature.containsRealData).toBe(false);
  expect(cassette.entries.length).toBeGreaterThan(0);
  expect(`${cassetteText}\n${signatureText}`).not.toMatch(
    /(?:canary|[\w.%+-]+@example\.(?:com|net|org))/iu,
  );

  await withGoldenTracing(async () => {
    const scenario = await recordGoldenScenario();
    const firstRequest = scenario.model.requests[0]?.request;
    if (firstRequest === undefined) {
      throw new Error("Expected a recorded synthetic model request.");
    }
    const store = new FileCassetteStore(cassettePath);
    await expect(store.get(requestHash(firstRequest), firstRequest)).resolves.toBeDefined();
  });
});

it("updates the golden only through the explicit command and refuses CI updates", async () => {
  await expect(
    runReplayGolden({ command: "update", directory: "/tmp/replay-golden-ci", inCi: true }),
  ).rejects.toMatchObject({ code: "baseline_update_refused" });
});
