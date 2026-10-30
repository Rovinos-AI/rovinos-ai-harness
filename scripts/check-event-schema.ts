// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EVENT_SCHEMA_VERSIONS,
  EventSchema,
  Sha256Hex,
  UPCASTERS,
  parseJson,
  type EventType,
  type EventUpcaster,
  type EventUpcasterMap,
} from "@rovinos/schemas";
import { z } from "zod";

/** One event type's schema version and canonical JSON Schema hash. */
export const EventSchemaLockEntrySchema = z
  .object({
    v: z.number().int().positive(),
    hash: Sha256Hex,
  })
  .strict();

/** Committed event schema versions and hashes. */
export const EventSchemaLockSchema = z.record(z.string().min(1), EventSchemaLockEntrySchema);

/** Inferred event schema lock entry. */
export type EventSchemaLockEntry = z.infer<typeof EventSchemaLockEntrySchema>;

/** One version-lock validation failure, containing only the event type and a closed code. */
export const EventSchemaLockIssueSchema = z
  .object({
    type: z.string().min(1),
    code: z.enum([
      "missing_entry",
      "unexpected_entry",
      "hash_drift",
      "version_rollback",
      "upcaster_missing",
      "new_event_version_invalid",
    ]),
    version: z.number().int().positive().optional(),
  })
  .strict();

/** Inferred event schema lock issue. */
export type EventSchemaLockIssue = z.infer<typeof EventSchemaLockIssueSchema>;

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .sort(([left], [right]) => compareNames(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized;
}

function schemaHash(schema: z.ZodType): EventSchemaLockEntry["hash"] {
  const jsonSchema = z.toJSONSchema(schema, {
    cycles: "ref",
    io: "input",
    reused: "inline",
    target: "draft-2020-12",
  });
  return Sha256Hex.parse(
    createHash("sha256").update(canonicalJson(jsonSchema), "utf8").digest("hex"),
  );
}

/** Builds the current lock snapshot from every strict event schema. */
export function createEventSchemaLock(): Record<EventType, EventSchemaLockEntry> {
  const entryFor = (type: EventType): EventSchemaLockEntry => {
    const schema = EventSchema.options.find((candidate) => candidate.shape.type.value === type);
    if (schema === undefined) {
      throw new TypeError("Event type has no schema.");
    }
    return { v: EVENT_SCHEMA_VERSIONS[type], hash: schemaHash(schema) };
  };
  return {
    run_created: entryFor("run_created"),
    run_input: entryFor("run_input"),
    run_status_changed: entryFor("run_status_changed"),
    model_request: entryFor("model_request"),
    model_response: entryFor("model_response"),
    tool_intent: entryFor("tool_intent"),
    tool_execution_started: entryFor("tool_execution_started"),
    tool_result: entryFor("tool_result"),
    approval_requested: entryFor("approval_requested"),
    approval_resolved: entryFor("approval_resolved"),
    input_requested: entryFor("input_requested"),
    input_resolved: entryFor("input_resolved"),
    app_content: entryFor("app_content"),
    checkpoint_written: entryFor("checkpoint_written"),
    context_compacted: entryFor("context_compacted"),
    pii_action: entryFor("pii_action"),
    budget_exceeded: entryFor("budget_exceeded"),
    subagent_spawned: entryFor("subagent_spawned"),
    subagent_completed: entryFor("subagent_completed"),
  };
}

function upcastersFor(
  type: string,
  upcasters: EventUpcasterMap,
): Readonly<Record<number, EventUpcaster>> | undefined {
  for (const [candidate, map] of Object.entries(upcasters)) {
    if (candidate === type) {
      return map;
    }
  }
  return undefined;
}

/** Evaluates schema hash drift, missing entries, and migration-chain completeness. */
export function evaluateEventSchemaLock(
  current: Readonly<Record<string, EventSchemaLockEntry>>,
  locked: Readonly<Record<string, EventSchemaLockEntry>>,
  upcasters: EventUpcasterMap = UPCASTERS,
): EventSchemaLockIssue[] {
  const issues: EventSchemaLockIssue[] = [];
  for (const [type, schema] of Object.entries(current)) {
    const previous = locked[type];
    if (previous === undefined) {
      issues.push({ type, code: "missing_entry" });
      if (schema.v !== 1) {
        issues.push({ type, code: "new_event_version_invalid", version: schema.v });
      }
      continue;
    }
    if (schema.v < previous.v) {
      issues.push({ type, code: "version_rollback", version: schema.v });
      continue;
    }
    if (schema.v === previous.v) {
      if (schema.hash !== previous.hash) {
        issues.push({ type, code: "hash_drift", version: schema.v });
      }
      continue;
    }
    const upcastersForType = upcastersFor(type, upcasters);
    for (let version = previous.v; version < schema.v; version += 1) {
      if (upcastersForType?.[version] === undefined) {
        issues.push({ type, code: "upcaster_missing", version });
      }
    }
  }
  for (const type of Object.keys(locked)) {
    if (!Object.hasOwn(current, type)) {
      issues.push({ type, code: "unexpected_entry" });
    }
  }
  return issues.sort((left, right) => {
    const typeOrder = compareNames(left.type, right.type);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    const codeOrder = compareNames(left.code, right.code);
    if (codeOrder !== 0) {
      return codeOrder;
    }
    return (left.version ?? 0) - (right.version ?? 0);
  });
}

function readLock(path: string): Record<string, EventSchemaLockEntry> {
  return parseJson(EventSchemaLockSchema, readFileSync(path, "utf8"));
}

function formatIssues(issues: readonly EventSchemaLockIssue[]): string {
  return issues
    .map(
      ({ type, code, version }) =>
        `${type}: ${code}${version === undefined ? "" : ` (${String(version)})`}`,
    )
    .join("\n");
}

/** Checks or deliberately updates the committed event schema lock. */
export function checkEventSchema(root: string, update: boolean): EventSchemaLockIssue[] {
  const lockPath = `${root}/packages/schemas/event-schema.lock.json`;
  const current = createEventSchemaLock();
  const lockExists = existsSync(lockPath);
  if (update && !lockExists) {
    writeFileSync(lockPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    return [];
  }
  const locked = lockExists ? readLock(lockPath) : {};
  const issues = evaluateEventSchemaLock(current, locked);
  const blockingIssues = update ? issues.filter(({ code }) => code !== "missing_entry") : issues;
  if (blockingIssues.length > 0) {
    return blockingIssues;
  }
  if (update) {
    writeFileSync(lockPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  }
  return [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes("--update");
  const unknownArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--update" && argument !== "--check");
  if (
    unknownArguments.length > 0 ||
    (process.argv.includes("--update") && process.argv.includes("--check"))
  ) {
    process.stderr.write("Usage: check-event-schema.ts [--check | --update]\n");
    process.exitCode = 2;
  } else {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const issues = checkEventSchema(root, update);
    if (issues.length > 0) {
      process.stderr.write(`${formatIssues(issues)}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        update ? "Event schema lock updated.\n" : "Event schema lock is current.\n",
      );
    }
  }
}
