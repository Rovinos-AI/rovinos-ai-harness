// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Sha256Hex } from "@rovinos/schemas";
import {
  createEventSchemaLock,
  evaluateEventSchemaLock,
  type EventSchemaLockEntry,
} from "./check-event-schema.js";

const original: EventSchemaLockEntry = { v: 1, hash: Sha256Hex.parse("a".repeat(64)) };
const changed: EventSchemaLockEntry = { v: 1, hash: Sha256Hex.parse("b".repeat(64)) };
const versionTwo: EventSchemaLockEntry = { v: 2, hash: Sha256Hex.parse("b".repeat(64)) };

describe("evaluateEventSchemaLock", () => {
  it("accepts a lock generated from every current event schema", () => {
    const current = createEventSchemaLock();
    expect(evaluateEventSchemaLock(current, current)).toEqual([]);
  });

  it("detects hash drift without a version bump", () => {
    expect(evaluateEventSchemaLock({ run_created: changed }, { run_created: original })).toEqual([
      { type: "run_created", code: "hash_drift", version: 1 },
    ]);
  });

  it("requires every upcaster in a version chain", () => {
    expect(
      evaluateEventSchemaLock(
        { approval_resolved: versionTwo },
        { approval_resolved: original },
        {},
      ),
    ).toEqual([{ type: "approval_resolved", code: "upcaster_missing", version: 1 }]);
  });

  it("detects missing lock entries", () => {
    expect(evaluateEventSchemaLock({ run_created: original }, {})).toEqual([
      { type: "run_created", code: "missing_entry" },
    ]);
  });

  it("accepts a version bump with its complete upcaster chain", () => {
    expect(
      evaluateEventSchemaLock({ approval_resolved: versionTwo }, { approval_resolved: original }),
    ).toEqual([]);
  });
});
