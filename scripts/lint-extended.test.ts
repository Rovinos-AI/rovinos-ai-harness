// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { lint } from "./lint-extended.js";

const rootDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));

it("builds extended lint commands through the injected runner", () => {
  const temporaryRoot = mkdtempSync(resolve(rootDirectory, ".lint-command-fixture-"));
  const calls: { command: string; args: string[]; tool: string }[] = [];
  const runner = (command: string, args: string[], tool: string): boolean => {
    calls.push({ command, args, tool });
    return true;
  };

  try {
    const dockerfile = resolve(temporaryRoot, "Dockerfile");
    const shellFile = resolve(temporaryRoot, "fixture.sh");
    writeFileSync(dockerfile, `FROM node:26-slim@sha256:${"a".repeat(64)}\n`);
    writeFileSync(
      shellFile,
      "#!/usr/bin/env bash\n# SPDX-License-Identifier: Apache-2.0\nset -euo pipefail\n",
    );

    expect(
      lint("docker", [relative(rootDirectory, dockerfile)], { runner, pullImages: false }),
    ).toBe(true);
    expect(calls.at(-1)?.args).toContain("--pull=never");
    expect(calls.at(-1)?.args).toContain(
      "hadolint/hadolint:v2.14.0-debian@sha256:158cd0184dcaa18bd8ec20b61f4c1cabdf8b32a592d062f57bdcb8e4c1d312e2",
    );

    expect(
      lint("docker", [relative(rootDirectory, dockerfile)], { runner, pullImages: true }),
    ).toBe(true);
    expect(calls.at(-1)?.args).toContain("--pull=always");

    expect(
      lint("editorconfig", [relative(rootDirectory, temporaryRoot)], { runner, pullImages: false }),
    ).toBe(true);
    expect(calls.at(-1)?.args).toContain("--pull=never");
    expect(calls.at(-1)?.args).toContain(
      "ghcr.io/editorconfig-checker/editorconfig-checker:4.0.2@sha256:2ba6232bfa0058f72f5f7d7816711590aa764afab1542af30b3ecb4553587918",
    );

    expect(lint("shell", [relative(rootDirectory, shellFile)], { runner })).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      command: "shellcheck",
      args: ["--severity=style", relative(rootDirectory, shellFile)],
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

it("rejects shell fixtures without strict mode before invoking ShellCheck", () => {
  const temporaryRoot = mkdtempSync(resolve(rootDirectory, ".lint-shell-fixture-"));
  let invoked = false;

  try {
    const shellFile = resolve(temporaryRoot, "fixture.sh");
    writeFileSync(
      shellFile,
      "#!/usr/bin/env bash\n# SPDX-License-Identifier: Apache-2.0\nprintf ready\n",
    );

    expect(
      lint("shell", [relative(rootDirectory, shellFile)], {
        runner: () => {
          invoked = true;
          return true;
        },
      }),
    ).toBe(false);
    expect(invoked).toBe(false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
