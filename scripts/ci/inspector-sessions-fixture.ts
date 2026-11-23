// SPDX-License-Identifier: Apache-2.0
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code, ControlPlaneConfigSchema, type Id, type NewEvent } from "@rovinos/schemas";
import { createEventBuilders } from "@rovinos/store/testing";
import { SqliteEventStore } from "@rovinos/store-sqlite";

/** Approval scenarios exercised by the advisory session probe. */
export type Scenario = "confirmed" | "declined" | "replay";
/** Result of one approval scenario. */
export type ScenarioStatus = "not_run" | "passed" | "failed";

/** Identifiers for a synthetic pending approval. */
export interface PendingApproval {
  readonly runId: ReturnType<typeof Id.parse>;
  readonly approvalId: ReturnType<typeof Id.parse>;
}

/** Temporary harness data and environment for one probe execution. */
export interface SessionFixture {
  readonly workDir: string;
  readonly home: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly configPath: string;
  readonly env: Record<string, string>;
  readonly approvals: Record<Scenario, PendingApproval>;
}

/** Durable approval resolution events found for a fixture. */
export interface ApprovalResolutions {
  readonly decisions: string[];
  readonly count: number;
}

class TimestampSequence {
  private value = 3;

  next(): number {
    return this.value++;
  }
}

async function addPendingApproval(
  store: SqliteEventStore,
  builders: ReturnType<typeof createEventBuilders>,
  timestamp: TimestampSequence,
): Promise<PendingApproval> {
  const runId = builders.nextRunId();
  const callId = builders.nextRunId();
  const approvalId = builders.nextRunId();
  const events: NewEvent[] = [
    builders.runCreated(runId),
    builders.runStatusChanged(runId, "pending", "running"),
    {
      runId,
      ts: timestamp.next(),
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "tool_intent",
      callId,
      toolId: Code.parse("tool.inspector.synthetic"),
      idempotent: false,
      policyDecision: "ask",
      ruleId: Code.parse("approval.inspector.synthetic"),
      argsHash: "c".repeat(64),
      args: { fixture: "synthetic" },
    },
    {
      runId,
      ts: timestamp.next(),
      v: 1,
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      segmentId: runId,
      type: "approval_requested",
      approvalId,
      callId,
      payload: {
        payloadVersion: 1,
        kind: "tool_call",
        callId,
        toolId: "tool.inspector.synthetic",
        args: { fixture: "synthetic" },
        ruleId: "approval.inspector.synthetic",
        reason: "policy.ask",
        summary: "Review synthetic Inspector fixture",
        ui: {
          resourceUri: "ui://harness/approval/v1",
          fallbackText: "Review this synthetic Inspector approval.",
        },
        editableFields: [],
      },
    },
    builders.runStatusChanged(runId, "running", "suspended"),
  ];
  await store.append(runId, events, 0);
  return { runId, approvalId };
}

/** Creates isolated synthetic state for all three Inspector session scenarios. */
export async function createSessionFixture(): Promise<SessionFixture> {
  const workDir = await mkdtemp(join(tmpdir(), "harness-inspector-sessions-"));
  let store: SqliteEventStore | undefined;
  try {
    const home = join(workDir, "home");
    const dataDir = join(workDir, "data");
    const configPath = join(workDir, "harness.config.json");
    const dbPath = join(dataDir, "harness.db");
    await Promise.all([mkdir(home), mkdir(dataDir)]);
    const controlPlane = ControlPlaneConfigSchema.parse({});
    await writeFile(configPath, `${JSON.stringify({ controlPlane })}\n`, { mode: 0o600 });
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      HARNESS_CONFIG: configPath,
      HARNESS_DATA_DIR: dataDir,
      MCP_INSPECTOR_SECRET_STORE: "memory",
      MCP_STORAGE_DIR: join(home, "storage"),
      MCP_CATALOG_PATH: join(home, "catalog.json"),
      MCP_AUTO_OPEN_ENABLED: "false",
    };
    store = new SqliteEventStore(dbPath);
    const builders = createEventBuilders();
    const timestamp = new TimestampSequence();
    const approvals = {
      confirmed: await addPendingApproval(store, builders, timestamp),
      declined: await addPendingApproval(store, builders, timestamp),
      replay: await addPendingApproval(store, builders, timestamp),
    };
    await store.close();
    return { workDir, home, dataDir, dbPath, configPath, env, approvals };
  } catch (error) {
    await store?.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

/** Reads the recorded resolutions for one synthetic approval. */
export async function readApprovalResolutions(
  dbPath: string,
  approval: PendingApproval,
): Promise<ApprovalResolutions> {
  const store = new SqliteEventStore(dbPath);
  try {
    const decisions: string[] = [];
    for await (const event of store.read(approval.runId)) {
      if (event.type === "approval_resolved" && event.approvalId === approval.approvalId) {
        decisions.push(event.decision);
      }
    }
    return { decisions, count: decisions.length };
  } finally {
    await store.close();
  }
}
