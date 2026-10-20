// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { FakeClock, Id } from "@harness/schemas";
import {
  EnqueueRunJobSchema,
  InvalidRunQueueInputError,
  SystemRunQueueIdGenerator,
  parseQueueInput,
} from "./types.js";

function captureError(callback: () => void): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return undefined;
}

it("generates ULIDs from the injected queue clock", () => {
  const id = new SystemRunQueueIdGenerator(new FakeClock(42)).next();
  expect(Id.parse(id)).toBe(id);
});

it("retains only input paths when queue input is invalid", () => {
  const canary = "synthetic-private-queue-input";
  const error = captureError(() => {
    parseQueueInput(EnqueueRunJobSchema, { kind: "invalid", runId: canary });
  });
  expect(error).toBeInstanceOf(InvalidRunQueueInputError);
  expect(JSON.stringify(error)).not.toContain(canary);
  const paths = error instanceof InvalidRunQueueInputError ? error.paths : [];
  expect(paths).toContainEqual(["kind"]);
});
