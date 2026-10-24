// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import {
  ApprovalListResultSchema,
  KeyGenerateResultSchema,
  RunResultSchema,
  parseJson,
} from "@harness/schemas";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

const ROOT_DIRECTORY = resolve(fileURLToPath(new URL("../", import.meta.url)));
const ENV_DIRECTORY = "examples/quickstart";
const ENV_FILE = join(ENV_DIRECTORY, ".env");
const ENV_EXAMPLE = join(ENV_DIRECTORY, ".env.example");
const COMPOSE_FILE = join(ENV_DIRECTORY, "docker-compose.quickstart.yml");
const FIXES: Record<QuickstartErrorCode, string> = {
  quickstart_approval_missing: "Inspect the suspended run and resolve its pending approval.",
  quickstart_command_failed: "Check Docker availability, then retry or run `yarn quickstart:down`.",
  quickstart_compose_missing: "Install Docker Compose v2, then retry `yarn quickstart`.",
  quickstart_docker_missing: "Install Docker Engine or Docker Desktop with Compose v2, then retry.",
  quickstart_env_invalid: "Restore examples/quickstart/.env from .env.example and retry.",
  quickstart_output_invalid: "Check the local harness image and retry `yarn quickstart`.",
  quickstart_usage: "Use `yarn quickstart [--yes]` or `yarn quickstart:down`.",
};

/** Closed failure codes emitted by the one-command quickstart. */
export type QuickstartErrorCode =
  | "quickstart_approval_missing"
  | "quickstart_command_failed"
  | "quickstart_compose_missing"
  | "quickstart_docker_missing"
  | "quickstart_env_invalid"
  | "quickstart_output_invalid"
  | "quickstart_usage";

/** A safe, typed quickstart failure with a one-line recovery hint. */
export class QuickstartError extends Error {
  readonly code: QuickstartErrorCode;

  constructor(code: QuickstartErrorCode) {
    super(code);
    this.name = "QuickstartError";
    this.code = code;
  }

  get fix(): string {
    return FIXES[this.code];
  }
}

/** Captured result of running a command for the quickstart. */
export interface QuickstartCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error: Error | undefined;
}

/** Safe argv-only spawn options used by every quickstart subprocess. */
export interface QuickstartSpawnOptions {
  readonly cwd: string;
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: boolean;
  readonly timeout: number;
}

/** Injectable argv-only command runner for deterministic quickstart tests. */
export type QuickstartCommandRunner = (
  command: string,
  args: readonly string[],
  options: QuickstartSpawnOptions,
) => QuickstartCommandResult;

/** Dependencies and output hooks for quickstart execution. */
export interface QuickstartOptions {
  readonly rootDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly yes?: boolean;
  readonly runCommand?: QuickstartCommandRunner;
  readonly writeOutput?: (text: string) => void;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: QuickstartSpawnOptions,
): QuickstartCommandResult {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout,
    error: result.error,
  };
}

function spawnOptions(rootDirectory: string): QuickstartSpawnOptions {
  return {
    cwd: rootDirectory,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    timeout: 20 * 60_000,
  };
}

function invoke(
  runCommand: QuickstartCommandRunner,
  command: string,
  args: readonly string[],
  rootDirectory: string,
): QuickstartCommandResult {
  return runCommand(command, args, spawnOptions(rootDirectory));
}

function checkDocker(rootDirectory: string, runCommand: QuickstartCommandRunner): void {
  const docker = invoke(runCommand, "docker", ["--version"], rootDirectory);
  if (docker.error !== undefined || docker.status !== 0) {
    throw new QuickstartError("quickstart_docker_missing");
  }
  const compose = invoke(runCommand, "docker", ["compose", "version"], rootDirectory);
  if (compose.error !== undefined || compose.status !== 0) {
    throw new QuickstartError("quickstart_compose_missing");
  }
}

function composeArgs(): string[] {
  return ["compose", "--env-file", ENV_FILE, "--file", COMPOSE_FILE];
}

function runCompose(
  rootDirectory: string,
  args: readonly string[],
  acceptedStatuses: readonly number[],
  runCommand: QuickstartCommandRunner,
): string {
  const result = invoke(runCommand, "docker", [...composeArgs(), ...args], rootDirectory);
  if (result.error !== undefined || !acceptedStatuses.includes(result.status ?? -1)) {
    throw new QuickstartError("quickstart_command_failed");
  }
  return result.stdout;
}

function createEnvironment(rootDirectory: string): void {
  const envPath = join(rootDirectory, ENV_FILE);
  if (!existsSync(envPath)) {
    let file: number | undefined;
    try {
      file = openSync(envPath, "wx", 0o600);
      writeFileSync(file, readFileSync(join(rootDirectory, ENV_EXAMPLE)));
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
        !existsSync(envPath)
      ) {
        throw new QuickstartError("quickstart_env_invalid");
      }
    } finally {
      if (file !== undefined) {
        closeSync(file);
      }
    }
  }

  try {
    if (!lstatSync(envPath).isFile()) {
      throw new QuickstartError("quickstart_env_invalid");
    }
    chmodSync(envPath, 0o600);
  } catch {
    throw new QuickstartError("quickstart_env_invalid");
  }
}

function writeEnvironmentKey(rootDirectory: string, key: string): void {
  const envPath = join(rootDirectory, ENV_FILE);
  const contents = readFileSync(envPath, "utf8");
  const lines = contents.split(/\r?\n/u);
  const keyLine = lines.findIndex((line) => line.startsWith("HARNESS_KEY="));
  if (keyLine < 0) {
    lines.push(`HARNESS_KEY=${key}`);
  } else {
    lines[keyLine] = `HARNESS_KEY=${key}`;
  }
  const tempPath = `${envPath}.${randomUUID()}.tmp`;
  let file: number | undefined;
  try {
    file = openSync(tempPath, "wx", 0o600);
    writeFileSync(file, `${lines.join("\n").replace(/\n*$/u, "")}\n`, "utf8");
    closeSync(file);
    file = undefined;
    renameSync(tempPath, envPath);
    chmodSync(envPath, 0o600);
  } catch {
    if (file !== undefined) {
      closeSync(file);
    }
    unlinkSync(tempPath);
    throw new QuickstartError("quickstart_env_invalid");
  }
}

function parseOutput<Schema extends z.ZodType>(schema: Schema, text: string): z.infer<Schema> {
  try {
    return parseJson(schema, text);
  } catch {
    throw new QuickstartError("quickstart_output_invalid");
  }
}

function ensureKey(rootDirectory: string, runCommand: QuickstartCommandRunner): void {
  const envText = readFileSync(join(rootDirectory, ENV_FILE), "utf8");
  const existingKey = envText
    .split(/\r?\n/u)
    .find((line) => line.startsWith("HARNESS_KEY="))
    ?.slice("HARNESS_KEY=".length);
  if (existingKey !== undefined && existingKey.trim() !== "") {
    return;
  }

  const output = runCompose(
    rootDirectory,
    ["run", "--rm", "--no-deps", "harness", "--json", "keys", "generate"],
    [0],
    runCommand,
  );
  const result = parseOutput(KeyGenerateResultSchema, output);
  writeEnvironmentKey(rootDirectory, result.key);
}

function printCommands(
  writeOutput: (text: string) => void,
  runId: string,
  approvalId: string,
): void {
  const prefix = `docker compose --env-file ${ENV_FILE} --file ${COMPOSE_FILE} run --rm --no-deps harness`;
  writeOutput(`Run ${runId} is suspended pending approval ${approvalId}.\n`);
  writeOutput(`Approve: ${prefix} approvals approve ${approvalId} --yes\n`);
  writeOutput(
    `Resume: ${prefix} resume ${runId} --fake-model ${ENV_DIRECTORY}/resume-model.script.json\n`,
  );
}

/** Creates the quickstart environment and runs the sample through Docker Compose. */
export function runQuickstart(options: QuickstartOptions = {}): void {
  const rootDirectory = options.rootDirectory ?? ROOT_DIRECTORY;
  const runCommand = options.runCommand ?? runProcess;
  const writeOutput = options.writeOutput ?? ((text: string) => process.stdout.write(text));
  checkDocker(rootDirectory, runCommand);
  prepareStack(rootDirectory, runCommand, writeOutput);
  const run = startSample(rootDirectory, runCommand);
  if (run.status !== "suspended") {
    if (run.status !== "completed") {
      throw new QuickstartError("quickstart_command_failed");
    }
    writeOutput(`Run ${run.runId} completed.\n`);
    return;
  }
  const approvalId = findApproval(rootDirectory, run.runId, runCommand);
  printCommands(writeOutput, run.runId, approvalId);

  if (options.yes === true) {
    approveAndResume(rootDirectory, run.runId, approvalId, runCommand);
    writeOutput(`Run ${run.runId} completed.\n`);
  }
}

function prepareStack(
  rootDirectory: string,
  runCommand: QuickstartCommandRunner,
  writeOutput: (text: string) => void,
): void {
  createEnvironment(rootDirectory);
  writeOutput("Building harness image...\n");
  runCompose(rootDirectory, ["build", "harness"], [0], runCommand);
  ensureKey(rootDirectory, runCommand);
  writeOutput("Building sandbox-runner image...\n");
  runCompose(rootDirectory, ["build", "sandbox-runner"], [0], runCommand);
  runCompose(rootDirectory, ["up", "-d", "--wait", "sandbox-runner"], [0], runCommand);
}

function startSample(rootDirectory: string, runCommand: QuickstartCommandRunner) {
  const output = runCompose(
    rootDirectory,
    [
      "run",
      "--rm",
      "--no-deps",
      "harness",
      "--json",
      "run",
      "--input",
      `${ENV_DIRECTORY}/task.json`,
      "--fake-model",
      `${ENV_DIRECTORY}/fake-model.script.json`,
    ],
    [0, 5],
    runCommand,
  );
  return parseOutput(RunResultSchema, output);
}

function findApproval(
  rootDirectory: string,
  runId: string,
  runCommand: QuickstartCommandRunner,
): string {
  const output = runCompose(
    rootDirectory,
    ["run", "--rm", "--no-deps", "harness", "--json", "approvals", "list"],
    [0],
    runCommand,
  );
  const approval = parseOutput(ApprovalListResultSchema, output).approvals.find(
    (entry) => entry.runId === runId,
  );
  if (approval === undefined) {
    throw new QuickstartError("quickstart_approval_missing");
  }
  return approval.approvalId;
}

function approveAndResume(
  rootDirectory: string,
  runId: string,
  approvalId: string,
  runCommand: QuickstartCommandRunner,
): void {
  runCompose(
    rootDirectory,
    ["run", "--rm", "--no-deps", "harness", "--json", "approvals", "approve", approvalId, "--yes"],
    [0],
    runCommand,
  );
  const output = runCompose(
    rootDirectory,
    [
      "run",
      "--rm",
      "--no-deps",
      "harness",
      "--json",
      "resume",
      runId,
      "--fake-model",
      `${ENV_DIRECTORY}/resume-model.script.json`,
    ],
    [0],
    runCommand,
  );
  const result = parseOutput(RunResultSchema, output);
  if (result.status !== "completed") {
    throw new QuickstartError("quickstart_command_failed");
  }
}

/** Runs `yarn quickstart` through Corepack for the Compose integration test. */
export function runQuickstartCli(options: {
  readonly yes?: boolean;
  readonly rootDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
}): number | null {
  const rootDirectory = options.rootDirectory ?? ROOT_DIRECTORY;
  const args = ["yarn", "quickstart", ...(options.yes === true ? ["--yes"] : [])];
  const result = spawnSync("corepack", args, {
    ...spawnOptions(rootDirectory),
    env: options.env ?? process.env,
  });
  return result.status;
}

/** Runs `yarn quickstart:down` through Corepack for the Compose integration test. */
export function runQuickstartDownCli(options: {
  readonly rootDirectory?: string;
  readonly env?: NodeJS.ProcessEnv;
}): number | null {
  const rootDirectory = options.rootDirectory ?? ROOT_DIRECTORY;
  const result = spawnSync("corepack", ["yarn", "quickstart:down"], {
    ...spawnOptions(rootDirectory),
    env: options.env ?? process.env,
    timeout: 5 * 60_000,
  });
  return result.status;
}

/** Stops the quickstart Compose stack and removes its named volumes and local `.env`. */
export function runQuickstartDown(options: QuickstartOptions = {}): void {
  const rootDirectory = options.rootDirectory ?? ROOT_DIRECTORY;
  const runCommand = options.runCommand ?? runProcess;
  const writeOutput = options.writeOutput ?? ((text: string) => process.stdout.write(text));
  checkDocker(rootDirectory, runCommand);
  const result = invoke(
    runCommand,
    "docker",
    ["compose", "--file", COMPOSE_FILE, "down", "--volumes", "--remove-orphans"],
    rootDirectory,
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new QuickstartError("quickstart_command_failed");
  }
  for (const path of [join(rootDirectory, ENV_FILE), `${join(rootDirectory, ENV_FILE)}.tmp`]) {
    try {
      unlinkSync(path);
    } catch {
      continue;
    }
  }
  writeOutput("Quickstart stack stopped; volumes and .env removed.\n");
}

function main(args: readonly string[]): void {
  try {
    if (args.length === 1 && args[0] === "--down") {
      runQuickstartDown();
      return;
    }
    if (args.some((arg) => arg !== "--yes")) {
      throw new QuickstartError("quickstart_usage");
    }
    runQuickstart({ yes: args.includes("--yes") });
  } catch (error) {
    const quickstartError =
      error instanceof QuickstartError ? error : new QuickstartError("quickstart_command_failed");
    process.stderr.write(`${quickstartError.code}: ${quickstartError.fix}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
