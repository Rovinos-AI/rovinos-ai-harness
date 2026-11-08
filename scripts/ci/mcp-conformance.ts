// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as createRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson, parseYaml } from "@rovinos/schemas";
import { z } from "zod";
import {
  INSPECTOR_HTTP_TOKEN,
  INSPECTOR_READ_TOKEN,
  startInspectorFixture,
} from "./inspector-http.js";
import { assertNoCredentialCanaries } from "./mcp-conformance-report-safety.js";

const root = resolvePath(import.meta.dirname, "../..");
const harness = resolvePath(root, "packages/cli/dist/bin.js");
const runner = resolvePath(root, "node_modules/@modelcontextprotocol/conformance/dist/index.js");
const protocolRevision = "2026-07-28";
const runnerRevision = "0.2.0-alpha.12";
const measuredScenarios = {
  client: ["tools_call"],
  server: ["server-stateless", "tools-list"],
} as const;
const roles = z.enum(["client", "server"]);
const requirementReason = z.enum(["extension", "added-after-release", "pending"]);
const requirementsSchema = z
  .object({
    server: z.array(z.string().min(1)),
    client: z.array(z.string().min(1)),
    not_scored: z.array(
      z
        .object({
          scenario: z.string().min(1),
          leg: roles,
          reason: requirementReason,
          note: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const scenarioStatus = z.enum(["passed", "failed", "skipped", "not_measured"]);
const scenarioReportSchema = z
  .object({
    scenario: z.string().min(1),
    status: scenarioStatus,
    reason: z.string().optional(),
  })
  .strict();
const notScoredReportSchema = z
  .object({
    scenario: z.string().min(1),
    role: roles,
    status: z.literal("not_scored"),
    reason: requirementReason,
    note: z.string().optional(),
  })
  .strict();
const notMeasuredCapabilitySchema = z
  .object({
    capability: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
const conformanceReportSchema = z
  .object({
    runner: z.literal(`@modelcontextprotocol/conformance@${runnerRevision}`),
    protocolRevision: z.literal(protocolRevision),
    advisory: z.literal(true),
    client: z.array(scenarioReportSchema),
    server: z.array(scenarioReportSchema),
    notScored: z.array(notScoredReportSchema),
    notMeasuredCapabilities: z.array(notMeasuredCapabilitySchema),
  })
  .strict();
const checksSchema = z.array(z.object({ status: z.string() }).passthrough());

export type ConformanceReport = z.infer<typeof conformanceReportSchema>;
export type ConformanceScenarioStatus = z.infer<typeof scenarioStatus>;

interface ProcessResult {
  readonly status: number;
}

interface RunningProxy {
  readonly endpoint: string;
  close(): Promise<void>;
}

function fail(code: string): never {
  throw new Error(code);
}

function runProcess(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("mcp_conformance_runner_timeout"));
    }, 180_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("mcp_conformance_runner_start_failed"));
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status: status ?? -1 });
    });
  });
}

function runnerEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
  };
}

function forward(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  token: string,
): void {
  if (request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  const upstream = createRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: request.url,
      method: request.method,
      headers: {
        ...request.headers,
        authorization: ["Be", "arer ", token].join(""),
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.once("error", () => {
    if (!response.headersSent) {
      response.writeHead(502);
    }
    response.end();
  });
  request.pipe(upstream);
}

async function startAuthProxy(endpoint: string): Promise<RunningProxy> {
  const target = new URL(endpoint);
  if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") {
    return fail("mcp_conformance_upstream_not_loopback");
  }
  const server = createServer((request, response) => {
    forward(request, response, target, INSPECTOR_HTTP_TOKEN);
    response.once("close", () => request.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return fail("mcp_conformance_proxy_listen_failed");
  }
  const { port } = address;
  return {
    endpoint: `http://127.0.0.1:${String(port)}/mcp`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  };
}

async function findChecks(directory: string): Promise<z.infer<typeof checksSchema>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const checks: z.infer<typeof checksSchema> = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      checks.push(...(await findChecks(path)));
    } else if (entry.isFile() && entry.name === "checks.json") {
      const parsed = parseJson(checksSchema, await readFile(path, "utf8"));
      checks.push(...parsed);
    }
  }
  return checks;
}

export async function runConformanceScenario(input: {
  readonly role: "client" | "server";
  readonly scenario: string;
  readonly outputDir: string;
  readonly endpoint: string;
  readonly home: string;
  readonly command?: string;
}): Promise<ConformanceScenarioStatus> {
  const outputDir = join(input.outputDir, input.role, input.scenario.replaceAll("/", "_"));
  await mkdir(outputDir, { recursive: true });
  const args = [
    runner,
    input.role,
    ...(input.role === "client"
      ? [
          "--command",
          input.command ?? "node --experimental-strip-types scripts/ci/mcp-conformance-client.ts",
        ]
      : ["--url", input.endpoint]),
    "--scenario",
    input.scenario,
    "--spec-version",
    protocolRevision,
    "--timeout",
    "60000",
    "--output-dir",
    outputDir,
  ];
  const result = await runProcess(args, root, runnerEnvironment(input.home));
  const checks = await findChecks(outputDir);
  if (result.status !== 0 || checks.some(({ status }) => status === "FAILURE" || status === "WARNING")) {
    return "failed";
  }
  if (checks.length === 0 || checks.some(({ status }) => status === "SKIPPED")) {
    return "skipped";
  }
  return checks.some(({ status }) => status === "SUCCESS") ? "passed" : "skipped";
}

function scenarioRows(
  role: "client" | "server",
  requirements: z.infer<typeof requirementsSchema>,
  measured: readonly string[],
  results: ReadonlyMap<string, ConformanceScenarioStatus>,
): z.infer<typeof scenarioReportSchema>[] {
  const required = requirements[role];
  if (measured.some((scenario) => !required.includes(scenario))) {
    fail("mcp_conformance_matrix_scenario_not_required");
  }
  return required.map((scenario) => {
    const status = results.get(scenario);
    return status === undefined
      ? {
          scenario,
          status: "not_measured" as const,
          reason: "outside the owner-approved initial capability matrix",
        }
      : { scenario, status };
  });
}

/** Runs only the owner-approved 2026 protocol capabilities and records the full frozen inventory. */
export async function runMcpConformanceLanes(outputDir: string): Promise<{
  readonly report: ConformanceReport;
  readonly exitCode: 0 | 1;
}> {
  const archiveDir = resolvePath(outputDir);
  const requirementsPath = join(
    root,
    "node_modules/@modelcontextprotocol/conformance/requirements",
    `${protocolRevision}.yaml`,
  );
  const requirementsText = await readFile(requirementsPath, "utf8");
  const requirements = parseYaml(requirementsSchema, requirementsText);
  const fixture = await startInspectorFixture({ root, harness });
  let workDir: string | undefined;
  let proxy: RunningProxy | undefined;
  try {
    workDir = await mkdtemp(join(tmpdir(), "mcp-conformance-"));
    await writeFile(join(workDir, "requirements-2026-07-28.yaml"), requirementsText);
    proxy = await startAuthProxy(fixture.endpoint);
    const clientResults = new Map<string, ConformanceScenarioStatus>();
    const serverResults = new Map<string, ConformanceScenarioStatus>();
    for (const scenario of measuredScenarios.client) {
      clientResults.set(
        scenario,
        await runConformanceScenario({
          role: "client",
          scenario,
          outputDir: workDir,
          endpoint: fixture.endpoint,
          home: fixture.home,
        }),
      );
    }
    for (const scenario of measuredScenarios.server) {
      serverResults.set(
        scenario,
        await runConformanceScenario({
          role: "server",
          scenario,
          outputDir: workDir,
          endpoint: proxy.endpoint,
          home: fixture.home,
        }),
      );
    }
    const report = conformanceReportSchema.parse({
      runner: `@modelcontextprotocol/conformance@${runnerRevision}`,
      protocolRevision,
      advisory: true,
      client: scenarioRows("client", requirements, measuredScenarios.client, clientResults),
      server: scenarioRows("server", requirements, measuredScenarios.server, serverResults),
      notScored: requirements.not_scored.map(({ scenario, leg, reason, note }) => ({
        scenario,
        role: leg,
        status: "not_scored" as const,
        reason,
        ...(note === undefined ? {} : { note }),
      })),
      notMeasuredCapabilities: [
        {
          capability: "bearer-token-expiry",
          reason: "Static control-plane bearer tokens have no expiration semantics.",
        },
        {
          capability: "bearer-token-revocation",
          reason: "Static control-plane bearer tokens cannot be revoked while the server is running.",
        },
      ],
    });
    await writeFile(join(workDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await assertNoCredentialCanaries(workDir, [INSPECTOR_HTTP_TOKEN, INSPECTOR_READ_TOKEN]);
    await mkdir(archiveDir, { recursive: true });
    await cp(workDir, archiveDir, { recursive: true });
    return {
      report,
      exitCode: requiredConformanceExitCode([
        ...clientResults.values(),
        ...serverResults.values(),
      ]),
    };
  } finally {
    await proxy?.close();
    await fixture.close();
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

/** Returns nonzero unless every scenario selected for measurement passed. */
export function requiredConformanceExitCode(
  statuses: readonly ConformanceScenarioStatus[],
): 0 | 1 {
  return statuses.every((status) => status === "passed") ? 0 : 1;
}

async function main(): Promise<void> {
  const outputDir = process.argv[2];
  if (outputDir === undefined) {
    process.stderr.write("mcp_conformance_output_directory_required\n");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await runMcpConformanceLanes(outputDir);
    process.stdout.write(
      `${JSON.stringify({
        runner: result.report.runner,
        protocolRevision: result.report.protocolRevision,
        advisory: result.report.advisory,
        client: result.report.client.filter(({ status }) => status !== "not_measured"),
        server: result.report.server.filter(({ status }) => status !== "not_measured"),
      })}\n`,
    );
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write("mcp_conformance_lane_failed\n");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolvePath(process.argv[1])
) {
  void main();
}
