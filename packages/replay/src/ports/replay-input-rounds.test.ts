// SPDX-License-Identifier: Apache-2.0
import type { RunContext } from "@rovinos/core";
import { describe, expect, it, vi } from "vitest";
import { inputCallId, inputState, inputToolId, recordInputRun } from "../input-fixture.js";
import { recordedInputResponses } from "./replay-inputs.js";
import { ReplayToolPort } from "./replay-tools.js";

describe("ReplayToolPort input rounds", () => {
  it("serves the final result only after every recorded round has been verified", async () => {
    const { resolved, toolRegistry } = await recordInputRun({ batch: true });
    const execute = vi.spyOn(toolRegistry, "execute");
    const port = new ReplayToolPort(resolved, toolRegistry);
    const events = resolved.runs[0]?.events ?? [];
    const resolutions = new Map(
      events
        .filter((event) => event.type === "input_resolved")
        .map((event) => [event.requestId, event]),
    );
    const handleInputRequired = vi.fn(() => Promise.resolve({ kind: "suspend" as const }));
    const context: RunContext = {
      runId: resolved.rootRunId,
      signal: new AbortController().signal,
      elicitation: { handleInputRequired },
    };
    const call = { callId: inputCallId, toolId: inputToolId, args: {} };
    expect(await port.execute(call, context)).toMatchObject({ suspend: true });
    for (const round of [1, 2]) {
      const requests = events
        .filter((event) => event.type === "input_requested")
        .filter((event) => event.round === round);
      const outcome = await port.execute(call, {
        ...context,
        inputRetry: {
          round,
          requestState: inputState,
          inputResponses: recordedInputResponses(requests, resolutions),
        },
      });
      expect(outcome).toMatchObject(
        round === 1 ? { suspend: true } : { outcome: "ok", result: { recorded: true } },
      );
    }
    expect(handleInputRequired).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["round", "state", "answer", "source"] as const)(
    "rejects a changed retry %s before serving the final result",
    async (mutation) => {
      const { resolved } = await recordInputRun({ rounds: 1 });
      const port = new ReplayToolPort(resolved);
      const events = resolved.runs[0]?.events ?? [];
      const resolutions = new Map(
        events
          .filter((event) => event.type === "input_resolved")
          .map((event) => [event.requestId, event]),
      );
      const requests = events.filter((event) => event.type === "input_requested");
      const context: RunContext = {
        runId: resolved.rootRunId,
        signal: new AbortController().signal,
        elicitation: { handleInputRequired: () => Promise.resolve({ kind: "suspend" }) },
      };
      const call = { callId: inputCallId, toolId: inputToolId, args: {} };
      await port.execute(call, context);
      const retry: NonNullable<RunContext["inputRetry"]> = {
        round: mutation === "round" ? 2 : 1,
        requestState: mutation === "state" ? "changed.synthetic.state" : inputState,
        source: mutation === "source" ? "mcp_legacy" : "mcp_mrtr",
        inputResponses:
          mutation === "answer"
            ? { email: { action: "accept", answer: { email: "<EMAIL_2>" } } }
            : recordedInputResponses(requests, resolutions),
      };
      await expect(port.execute(call, { ...context, inputRetry: retry })).rejects.toMatchObject({
        code: "replay_divergence",
        hashMismatchCode: "input_round_mismatch",
      });
    },
  );
});
