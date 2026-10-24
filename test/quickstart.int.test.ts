// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runQuickstartDocTests } from "../scripts/docs/run-doc-tests.js";
import { runQuickstartCli, runQuickstartDownCli } from "../scripts/quickstart.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

it(
  "executes every runnable command in the quickstart documentation",
  async () => {
    await expect(runQuickstartDocTests()).resolves.toBeUndefined();
  },
  30 * 60_000,
);

it(
  "runs the quickstart unattended and removes its stack and environment",
  () => {
    const env = {
      ...process.env,
      COMPOSE_PROJECT_NAME: `harness-quickstart-${randomUUID()}`,
    };
    try {
      expect(runQuickstartCli({ yes: true, rootDirectory: root, env })).toBe(0);
    } finally {
      expect(runQuickstartDownCli({ rootDirectory: root, env })).toBe(0);
    }
  },
  30 * 60_000,
);
