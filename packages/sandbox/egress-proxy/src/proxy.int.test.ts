// SPDX-License-Identifier: Apache-2.0
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Id, parseJson } from "@harness/schemas";
import { WebFetchResultSchema } from "../../src/web-fetch-contracts.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ExecResultSchema } from "../../src/types.js";
import type { ExecSpec } from "../../src/types.js";
import { egressProbeScript } from "./probe-script.js";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const projectName = `harness-sandbox-egress-${String(process.pid)}`;
const egressProbeIp = "198.51.101.3";
const egressProbeHost = "egress-probe-egress.test";
const integrationToken = "synthetic-sandbox-egress-token-for-integration";
const allowlist = [
  { host: egressProbeHost, ports: [8080] },
  { host: "metadata.example.test", ports: [80] },
];
const composeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  SANDBOX_RUNNER_TOKEN: integrationToken,
  // The image's runner identity owns /workspaces; other ids cannot create run directories.
  SANDBOX_RUNNER_UID: "10002",
  SANDBOX_RUNNER_GID: "10003",
  SANDBOX_EGRESS_ALLOW: JSON.stringify(allowlist),
  SANDBOX_EGRESS_SUBNET: "172.31.253.0/24",
  SANDBOX_EGRESS_PROXY_IP: "172.31.253.3",
  EGRESS_TEST_SUBNET: "198.51.101.0/24",
  EGRESS_PROBE_IP: egressProbeIp,
  EGRESS_PROBE_HOST: egressProbeHost,
};

const ResponseSchema = z.object({ status: z.number().int(), body: z.string() }).strict();

function composeArgs(args: string[]): string[] {
  return [
    "compose",
    "--env-file",
    "infra/collector/VERSION",
    "--project-name",
    projectName,
    "--profile",
    "sandbox",
    "--profile",
    "sandbox-egress",
    "--file",
    "infra/compose/docker-compose.yml",
    "--file",
    "infra/compose/docker-compose.egress.yml",
    "--file",
    "infra/compose/docker-compose.egress.test.yml",
    ...args,
  ];
}

async function runCompose(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", composeArgs(args), {
    cwd: root,
    env: composeEnvironment,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function readComposeConfig(): void {
  execFileSync("docker", composeArgs(["config"]), {
    cwd: root,
    env: composeEnvironment,
    encoding: "utf8",
  });
}

function makeSpec(argv: string[]): ExecSpec {
  return {
    argv,
    timeoutMs: 20_000,
    limits: { memoryMb: 2048, pids: 32, outputBytes: 4096, cpuSeconds: 5 },
  };
}

async function executeInRunner(script: string): Promise<z.infer<typeof ExecResultSchema>> {
  const body = JSON.stringify({
    runId: Id.parse("00000000000000000000000001"),
    spec: makeSpec(["node", "-e", script]),
  });
  const headers = JSON.stringify({
    host: "sandbox-runner:8080",
    authorization: ["Bearer", integrationToken].join(" "),
    "content-type": "application/json",
  });
  const clientScript = [
    'const http = require("node:http");',
    `const request = http.request({ hostname: "127.0.0.1", port: 8080, path: "/exec", method: "POST", headers: ${headers} }, (response) => {`,
    '  const chunks = []; response.on("data", (chunk) => chunks.push(chunk));',
    '  response.on("end", () => process.stdout.write(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString() })));',
    "});",
    `request.end(${JSON.stringify(body)});`,
  ].join("\n");
  const { stdout } = await execFileAsync(
    "docker",
    [...composeArgs(["exec", "--no-TTY", "sandbox-runner", "node", "-e", clientScript])],
    { cwd: root, env: composeEnvironment, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const response = parseJson(ResponseSchema, stdout);
  expect(response.status).toBe(200);
  return parseJson(ExecResultSchema, response.body);
}

async function requestRunnerFetch(url: string): Promise<z.infer<typeof ResponseSchema>> {
  const body = JSON.stringify({
    runId: Id.parse("00000000000000000000000001"),
    request: { url },
  });
  const headers = JSON.stringify({
    host: "sandbox-runner:8080",
    authorization: ["Bearer", integrationToken].join(" "),
    "content-type": "application/json",
  });
  const clientScript = [
    'const http = require("node:http");',
    `const request = http.request({ hostname: "127.0.0.1", port: 8080, path: "/fetch", method: "POST", headers: ${headers} }, (response) => {`,
    '  const chunks = []; response.on("data", (chunk) => chunks.push(chunk));',
    '  response.on("end", () => process.stdout.write(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString() })));',
    "});",
    `request.end(${JSON.stringify(body)});`,
  ].join("\n");
  const { stdout } = await execFileAsync(
    "docker",
    [...composeArgs(["exec", "--no-TTY", "sandbox-runner", "node", "-e", clientScript])],
    { cwd: root, env: composeEnvironment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return parseJson(ResponseSchema, stdout, { maxBytes: 4 * 1024 * 1024 });
}

describe("sandbox egress proxy Compose services", () => {
  beforeAll(async () => {
    readComposeConfig();
    await runCompose([
      "up",
      "--detach",
      "--wait",
      "--pull=missing",
      "sandbox-runner",
      "sandbox-egress-proxy",
      "egress-probe",
    ]);
  }, 180_000);

  afterAll(async () => {
    await runCompose(["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }, 60_000);

  // threat: T-05
  // threat: T-06
  it("allows only proxied public destinations and rejects direct, denied, and metadata routes", async () => {
    const result = await executeInRunner(egressProbeScript(egressProbeIp, egressProbeHost));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("{")).toBe(true);
    const output = parseJson(
      z
        .object({
          proxyEnvPresent: z.boolean(),
          allowed: ResponseSchema.optional(),
          denied: ResponseSchema.optional(),
          metadata: ResponseSchema.optional(),
          directProbe: z.union([z.boolean(), ResponseSchema]).optional(),
          directMetadata: z.union([z.boolean(), ResponseSchema]).optional(),
          pending: z.array(z.string()),
        })
        .strict(),
      result.stdout,
    );
    expect(output.pending, `Pending egress probes: ${output.pending.join(", ")}`).toEqual([]);
    expect(output).toEqual({
      proxyEnvPresent: true,
      allowed: { status: 200, body: "probe" },
      denied: { status: 403, body: "not_allowlisted" },
      metadata: { status: 502, body: "private_address" },
      directProbe: false,
      directMetadata: false,
      pending: [],
    });
  }, 30_000);

  // threat: T-05
  // threat: T-06
  it("fetches only allowlisted content, rejects redirect escapes, and keeps URL canaries out of logs", async () => {
    const html = await requestRunnerFetch(
      `http://${egressProbeHost}:8080/html?synthetic-fetch-query-canary`,
    );
    expect(html.status).toBe(200);
    expect(WebFetchResultSchema.parse(JSON.parse(html.body))).toMatchObject({
      url: `http://${egressProbeHost}:8080/html`,
      text: "visible",
      hiddenTextDropped: "hidden-canary".length,
      untrusted: true,
    });

    const denied = await requestRunnerFetch(`http://${egressProbeHost}:8080/redirect-denied`);
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("sandbox_fetch_denied");
    expect(denied.body).not.toContain("denied.example.test");

    const metadata = await requestRunnerFetch(`http://${egressProbeHost}:8080/redirect-metadata`);
    expect(metadata.status).toBe(200);
    expect(WebFetchResultSchema.parse(JSON.parse(metadata.body))).toMatchObject({
      status: 502,
      text: "private_address",
      untrusted: true,
    });

    const large = await requestRunnerFetch(`http://${egressProbeHost}:8080/large`);
    expect(large.status).toBe(200);
    expect(WebFetchResultSchema.parse(JSON.parse(large.body))).toMatchObject({
      truncated: true,
      untrusted: true,
    });

    const binary = await requestRunnerFetch(`http://${egressProbeHost}:8080/binary`);
    expect(WebFetchResultSchema.parse(JSON.parse(binary.body))).toMatchObject({
      binary: true,
      contentType: "image/png",
      bytes: [0, 1, 255],
      untrusted: true,
    });

    const logs = await runCompose(["logs", "--no-color", "sandbox-runner", "sandbox-egress-proxy"]);
    expect(logs).not.toContain("synthetic-fetch-query-canary");
    expect(logs).not.toContain(egressProbeHost);
  }, 60_000);
});
