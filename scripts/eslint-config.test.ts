// SPDX-License-Identifier: Apache-2.0
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const rootDirectory = resolve(import.meta.dirname, "..");

it("loads the ESLint config without a schemas build directory", async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "harness-eslint-config-"));
  const configFiles = [
    "eslint.config.js",
    "eslint-layer-config.js",
    "eslint-browser-boundaries.js",
    "eslint-yaml.js",
  ];

  try {
    mkdirSync(resolve(tempDirectory, "docs/engineering"), { recursive: true });
    mkdirSync(resolve(tempDirectory, "packages/schemas"), { recursive: true });
    writeFileSync(resolve(tempDirectory, "package.json"), '{"type":"module"}');
    symlinkSync(
      resolve(rootDirectory, "node_modules"),
      resolve(tempDirectory, "node_modules"),
      "dir",
    );
    copyFileSync(
      resolve(rootDirectory, "docs/engineering/layers.json"),
      resolve(tempDirectory, "docs/engineering/layers.json"),
    );
    for (const file of configFiles) {
      copyFileSync(resolve(rootDirectory, file), resolve(tempDirectory, file));
    }

    expect(existsSync(resolve(tempDirectory, "packages/schemas/dist"))).toBe(false);
    await import(
      `${pathToFileURL(resolve(tempDirectory, "eslint.config.js")).href}?test=${String(Date.now())}`
    );
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
