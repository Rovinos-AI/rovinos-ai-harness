// SPDX-License-Identifier: Apache-2.0
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";
import {
  connectMcpdoSession,
  disconnectMcpdoSession,
  runConfirmedMcpdoFlow,
  runDeclinedMcpdoFlow,
  stopMcpdoDaemon,
} from "./inspector-sessions-client.ts";
import { runReplayFlow } from "./inspector-sessions-replay.ts";
import {
  createSessionFixture,
  type Scenario,
  type ScenarioStatus,
  type SessionFixture,
} from "./inspector-sessions-fixture.ts";

const root = resolve(import.meta.dirname, "../..");
const reportPath = resolve(root, "reports/inspector-sessions/result.json");

class ScenarioResults {
  private readonly values: Record<Scenario, ScenarioStatus> = {
    confirmed: "not_run",
    declined: "not_run",
    replay: "not_run",
  };
  private active: Scenario = "confirmed";

  setActive(scenario: Scenario): void {
    this.active = scenario;
  }

  markPassed(): void {
    this.values[this.active] = "passed";
  }

  markFailed(): void {
    if (this.values[this.active] !== "passed") {
      this.values[this.active] = "failed";
    }
  }

  get statuses(): Record<Scenario, ScenarioStatus> {
    return this.values;
  }
}

async function inspectorVersion(): Promise<string> {
  const packageSchema = z.object({
    devDependencies: z.record(z.string(), z.string()),
  });
  const packageFile = await readFile(join(root, "package.json"), "utf8");
  const rootPackage = parseJson(packageSchema, packageFile);
  const version = rootPackage.devDependencies["@modelcontextprotocol/inspector"];
  if (version === undefined) {
    throw new Error("The pinned Inspector dependency is missing.");
  }
  return version;
}

async function writeReport(input: {
  readonly version: string;
  readonly status: "passed" | "failed" | "cancelled";
  readonly statuses: Record<Scenario, ScenarioStatus>;
  readonly errorCode?: string;
}): Promise<void> {
  await mkdir(join(root, "reports", "inspector-sessions"), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        inspectorVersion: input.version,
        transport: "stdio",
        protocolEra: "2026-07-28",
        testedRole: "MCP client",
        runStatus: "run",
        status: input.status,
        scenarios: input.statuses,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function runFlows(
  fixture: SessionFixture,
  connection: string,
  signal: AbortSignal,
  results: ScenarioResults,
): Promise<void> {
  await connectMcpdoSession(fixture, connection, signal);
  await runConfirmedMcpdoFlow(fixture, connection, signal);
  results.markPassed();
  results.setActive("declined");
  await runDeclinedMcpdoFlow(fixture, connection, signal);
  results.markPassed();
  await disconnectMcpdoSession(fixture, connection);
  results.setActive("replay");
  await runReplayFlow(fixture, signal);
  results.markPassed();
}

async function cleanupFixture(fixture: SessionFixture): Promise<void> {
  let failed = false;
  try {
    await stopMcpdoDaemon(fixture.env);
  } catch {
    failed = true;
  }
  try {
    await rm(fixture.workDir, { recursive: true, force: true });
  } catch {
    failed = true;
  }
  if (failed) {
    throw new Error("Inspector session cleanup failed.");
  }
}

function finalStatus(
  signal: AbortSignal,
  sessionError: unknown,
  cleanupError: unknown,
): "passed" | "failed" | "cancelled" {
  if (signal.aborted) {
    return "cancelled";
  }
  if (sessionError !== undefined || cleanupError !== undefined) {
    return "failed";
  }
  return "passed";
}

async function runInspectorSessions(): Promise<void> {
  const version = await inspectorVersion();
  const results = new ScenarioResults();
  const abortController = new AbortController();
  const abortOnSignal = (): void => {
    abortController.abort();
  };
  process.once("SIGINT", abortOnSignal);
  process.once("SIGTERM", abortOnSignal);
  let fixture: SessionFixture | undefined;
  let sessionError: unknown;
  let cleanupError: unknown;
  try {
    fixture = await createSessionFixture();
    await runFlows(
      fixture,
      `inspector-sessions-${String(process.pid)}`,
      abortController.signal,
      results,
    );
  } catch (error) {
    sessionError = error;
    results.markFailed();
  } finally {
    if (fixture !== undefined) {
      try {
        await cleanupFixture(fixture);
      } catch (error) {
        cleanupError = error;
      }
    }
    process.removeListener("SIGINT", abortOnSignal);
    process.removeListener("SIGTERM", abortOnSignal);
    const status = finalStatus(abortController.signal, sessionError, cleanupError);
    await writeReport({
      version,
      status,
      statuses: results.statuses,
      ...(status === "passed"
        ? {}
        : { errorCode: cleanupError !== undefined ? "cleanup_failed" : "session_failed" }),
    });
  }
  if (sessionError !== undefined || cleanupError !== undefined) {
    throw new Error("Inspector session probe failed.");
  }
}

runInspectorSessions().catch(() => {
  process.exitCode = 1;
});
