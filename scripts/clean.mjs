#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", ".yarn", "node_modules"]);

function clean(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "coverage") {
        rmSync(path, { recursive: true, force: true });
      } else if (!ignoredDirectories.has(entry.name)) {
        clean(path);
      }
    } else if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      unlinkSync(path);
    }
  }
}

clean(root);
