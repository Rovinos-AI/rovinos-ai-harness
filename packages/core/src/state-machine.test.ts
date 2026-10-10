// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import type { RunStatus } from "@harness/schemas";
import { canTransition, RUN_TRIGGERS, transition, type RunTrigger } from "./index.js";

const statuses: readonly RunStatus[] = [
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
];
const destinations: Record<RunStatus, Partial<Record<RunTrigger, RunStatus>>> = {
  pending: { start: "running", cancel: "cancelled" },
  running: {
    request_approval: "suspended",
    shutdown: "suspended",
    complete: "completed",
    fail: "failed",
    cancel: "cancelled",
  },
  suspended: { resume: "running", cancel: "cancelled", fail: "failed" },
  completed: {},
  failed: {},
  cancelled: {},
};

describe("transition", () => {
  test.each(
    statuses.flatMap((from) =>
      RUN_TRIGGERS.map((trigger) => ({ from, trigger, to: destinations[from][trigger] })),
    ),
  )("$from + $trigger", ({ from, trigger, to }) => {
    const expected =
      to === undefined ? { ok: false, code: "invalid_transition" } : { ok: true, to };
    expect(transition(from, trigger)).toEqual(expected);
    expect(canTransition(from, trigger)).toBe(to !== undefined);
  });

  test.each(["completed", "failed", "cancelled"] as const)("%s is absorbing", (status) => {
    for (const trigger of RUN_TRIGGERS) {
      expect(canTransition(status, trigger)).toBe(false);
    }
  });
});
