// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  QuickstartError,
  runQuickstart,
  runQuickstartDown,
  type QuickstartCommandRunner,
  type QuickstartSpawnOptions,
} from "./quickstart.js";

const runId = "00000000000000000000000001";
const approvalId = "00000000000000000000000002";
const generatedKey = `${"A".repeat(43)}=`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "quickstart-test-"));
  roots.push(root);
  mkdirSync(join(root, "examples/quickstart"), { recursive: true });
  writeFileSync(
    join(root, "examples/quickstart/.env.example"),
    "HARNESS_KEY=\nHARNESS_IMAGE=harness:quickstart\n",
  );
  return root;
}

function createCommandRunner(
  options: {
    readonly composeStatus?: number;
    readonly dockerStatus?: number;
  } = {},
) {
  const calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly options: QuickstartSpawnOptions;
  }[] = [];
  let keyGenerations = 0;
  const runCommand: QuickstartCommandRunner = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    if (args[0] === "--version") {
      return { status: options.dockerStatus ?? 0, stdout: "", error: undefined };
    }
    if (args[0] === "compose" && args[1] === "version") {
      return { status: options.composeStatus ?? 0, stdout: "", error: undefined };
    }
    if (args.includes("keys")) {
      keyGenerations += 1;
      return {
        status: 0,
        stdout: JSON.stringify({ key: generatedKey, instructions: "store securely" }),
        error: undefined,
      };
    }
    if (args.includes("approvals") && args.includes("list")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          approvals: [
            {
              approvalId,
              runId,
              toolId: "fs.write",
              ruleId: "write_file",
              requestedAt: 0,
              ageMs: 0,
              expiresAt: null,
            },
          ],
        }),
        error: undefined,
      };
    }
    if (args.includes("resume")) {
      return {
        status: 0,
        stdout: JSON.stringify({ runId, status: "completed" }),
        error: undefined,
      };
    }
    if (args.includes("--input")) {
      return {
        status: 5,
        stdout: JSON.stringify({ runId, status: "suspended" }),
        error: undefined,
      };
    }
    return { status: 0, stdout: "", error: undefined };
  };
  return {
    calls,
    get keyGenerations() {
      return keyGenerations;
    },
    runCommand,
  };
}

/** Asserts a thrown quickstart error exposes only its typed code and one-line fix. */
function expectQuickstartCode(action: () => void, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QuickstartError);
  if (!(caught instanceof QuickstartError)) {
    return;
  }
  expect(caught.code).toBe(code);
  expect(caught.fix).not.toContain("\n");
}

it("checks Docker prerequisites with typed errors and a one-line fix", () => {
  const root = createRoot();
  const commands = createCommandRunner({ dockerStatus: 127 });

  expectQuickstartCode(() => {
    runQuickstart({ rootDirectory: root, runCommand: commands.runCommand });
  }, "quickstart_docker_missing");
  expect(commands.calls).toHaveLength(1);
});

it("reports a missing Compose v2 installation with a typed error", () => {
  const root = createRoot();
  const commands = createCommandRunner({ composeStatus: 1 });

  expectQuickstartCode(() => {
    runQuickstart({ rootDirectory: root, runCommand: commands.runCommand });
  }, "quickstart_compose_missing");
  expect(commands.calls).toHaveLength(2);
});

it("creates a private environment once, never prints the key, and uses argv arrays", () => {
  const root = createRoot();
  const commands = createCommandRunner();
  const output: string[] = [];
  const writeOutput = (text: string) => {
    output.push(text);
  };

  runQuickstart({ rootDirectory: root, runCommand: commands.runCommand, writeOutput });
  runQuickstart({ rootDirectory: root, runCommand: commands.runCommand, writeOutput });

  const envPath = join(root, "examples/quickstart/.env");
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(envPath, "utf8")).toContain(`HARNESS_KEY=${generatedKey}`);
  expect(commands.keyGenerations).toBe(1);
  expect(output.join("")).not.toContain(generatedKey);
  expect(
    commands.calls.every(
      ({ command, args, options }) => command === "docker" && Array.isArray(args) && !options.shell,
    ),
  ).toBe(true);
  expect(
    commands.calls.findIndex(({ args }) => args.includes("harness") && args.includes("build")),
  ).toBeLessThan(
    commands.calls.findIndex(
      ({ args }) => args.includes("sandbox-runner") && args.includes("build"),
    ),
  );
});

it("approves and resumes the sample with --yes", () => {
  const root = createRoot();
  const commands = createCommandRunner();
  const output: string[] = [];

  runQuickstart({
    rootDirectory: root,
    yes: true,
    runCommand: commands.runCommand,
    writeOutput: (text) => {
      output.push(text);
    },
  });

  expect(
    commands.calls.some(({ args }) => args.includes("approve") && args.includes(approvalId)),
  ).toBe(true);
  expect(commands.calls.some(({ args }) => args.includes("resume") && args.includes(runId))).toBe(
    true,
  );
  expect(output.join("")).toContain(`Approve: docker compose --env-file examples/quickstart/.env`);
  expect(output.join("")).toContain(`Resume: docker compose --env-file examples/quickstart/.env`);
  expect(output.join("")).toContain(`Run ${runId} completed.`);
});

it("removes the stack volumes and generated environment", () => {
  const root = createRoot();
  const envPath = join(root, "examples/quickstart/.env");
  writeFileSync(envPath, "HARNESS_KEY=synthetic\n");
  const commands = createCommandRunner();

  runQuickstartDown({
    rootDirectory: root,
    runCommand: commands.runCommand,
    writeOutput: vi.fn(),
  });

  expect(
    commands.calls.some(({ args }) => args.includes("down") && args.includes("--volumes")),
  ).toBe(true);
  expect(() => statSync(envPath)).toThrow();
});
