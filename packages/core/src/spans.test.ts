// SPDX-License-Identifier: Apache-2.0
import { Code, Id } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import { RUN_SPAN, runSpanAttributes } from "./spans.js";

describe("run span eval attributes", () => {
  it("omits eval attributes for non-eval runs", () => {
    const attributes = runSpanAttributes({});

    expect(attributes).not.toHaveProperty("harness.eval.suite");
    expect(attributes).not.toHaveProperty("harness.eval.task");
    expect(attributes).not.toHaveProperty("harness.eval.trial");
  });

  it("validates suite, task, and trial attributes on the registered run span", () => {
    const evalAttributes = runSpanAttributes({
      evalMetadata: {
        suite: Code.parse("eval_suite"),
        task: Code.parse("synthetic_task"),
        trial: 2,
      },
    });

    expect(
      RUN_SPAN.schema.parse({
        ...evalAttributes,
        "harness.run.id": Id.parse("00000000000000000000000001"),
        "harness.segment.id": Id.parse("00000000000000000000000002"),
      }),
    ).toMatchObject({
      "harness.eval.suite": "eval_suite",
      "harness.eval.task": "synthetic_task",
      "harness.eval.trial": 2,
    });
  });
});
