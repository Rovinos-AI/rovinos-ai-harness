#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Regenerates the index blocks in every folder AGENTS.md and the dependency table in CONVENTIONS section 1.
// Inputs: epic-*.md headings, TASKS.md "Task ids:" lines, docs/engineering/layers.json.
// Usage: yarn gen:agents or yarn check:agents
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "@rovinos/schemas";
import { z } from "zod";

const BEGIN = "<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->";
const END = "<!-- END GENERATED: agents-index -->";
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".claude"]);
const layersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

function compareIds(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Compress task ids into ranges: ["2.1","2.2","2.3","4.1"] -> "2.1-2.3, 4.1".
 * Follow-up ids (`<epic>.<n>.<m>`, for example "1.1.1") sort after their parent and are never part of a range.
 */
export function compressIds(ids) {
  const parsed = ids.map((id) => id.split(".").map(Number)).sort(compareIds);
  const out = [];
  let start = null;
  let prev = null;
  const flush = () => {
    if (start) {
      out.push(start === prev ? start.join(".") : `${start.join(".")}-${prev.join(".")}`);
    }
  };
  for (const p of parsed) {
    const consecutive =
      p.length === 2 && prev?.length === 2 && p[0] === prev[0] && p[1] === prev[1] + 1;
    if (consecutive) {
      prev = p;
      continue;
    }
    flush();
    start = p;
    prev = p;
  }
  flush();
  return out.join(", ");
}

/** Throws on unknown dependencies or cycles. */
export function validateLayers(layers) {
  const names = Object.keys(layers).filter((k) => !k.startsWith("$"));
  for (const name of names) {
    for (const dep of layers[name]) {
      if (!names.includes(dep)) {
        throw new Error(`layers.json: ${name} imports unknown package ${dep}`);
      }
      if (dep === name) {
        throw new Error(`layers.json: ${name} imports itself`);
      }
    }
  }
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === "done") {
      return;
    }
    if (state.get(name) === "active") {
      throw new Error(`layers.json: cycle ${[...path, name].join(" -> ")}`);
    }
    state.set(name, "active");
    for (const dep of layers[name]) {
      visit(dep, [...path, name]);
    }
    state.set(name, "done");
  };
  for (const name of names) {
    visit(name, []);
  }
  return names;
}

/** Replace the generated section of a repository document.
 * @param text - Existing document contents.
 * @param body - Regenerated section contents.
 * @param file - Document path, used in errors.
 * @returns Updated document contents.
 */
export function replaceBlock(text, body, file) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(`${file}: missing generated block markers`);
  }
  return `${text.slice(0, a + BEGIN.length)}\n${body}\n${text.slice(b)}`;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function verifyPackageLayers(root, packages) {
  for (const directory of readdirSync(join(root, "packages"))) {
    if (
      statSync(join(root, "packages", directory)).isDirectory() &&
      !packages.includes(directory)
    ) {
      throw new Error(`layers.json: no entry for packages/${directory}`);
    }
  }
}

function findOwner(file, agentsDirs) {
  let directory = dirname(file);
  while (!agentsDirs.includes(directory)) {
    directory = directory === "." ? null : dirname(directory);
  }
  return directory;
}

function buildAgentBlock({ root, dir, files, agentsDirs, layers }) {
  const owned = files.filter((file) => findOwner(file, agentsDirs) === dir).sort();
  const lines = ["", "## Specs and task ids", ""];
  const taskListStart = lines.length;
  for (const file of owned.filter((entry) => /(?:^|\/)epic-[^/]+\.md$/.test(entry))) {
    const ids = [
      ...readFileSync(join(root, file), "utf8").matchAll(/^## (\d+\.\d+(?:\.\d+)?)\s/gm),
    ].map((match) => match[1]);
    lines.push(`- [${relative(dir, file)}](./${relative(dir, file)}): tasks ${compressIds(ids)}`);
  }
  for (const file of owned.filter((entry) => entry.endsWith("/TASKS.md") || entry === "TASKS.md")) {
    const match = readFileSync(join(root, file), "utf8").match(/^Task ids: (.+)$/m);
    if (!match) {
      throw new Error(`${file}: missing "Task ids:" line`);
    }
    lines.push(
      `- [${relative(dir, file)}](./${relative(dir, file)}) (specs in other folders): tasks ${match[1]}`,
    );
  }
  if (lines.length === taskListStart) {
    lines.push("- None. See `docs/engineering/tasks/README.md`.");
  }
  const pkg = dir.match(/^packages\/([^/]+)$/);
  if (pkg) {
    const deps = layers[pkg[1]];
    lines.push("", "## Allowed internal imports", "");
    lines.push(
      deps.length
        ? `- ${deps.map((dependency) => `\`@rovinos/${dependency}\``).join(", ")}. Nothing else from \`@rovinos/*\`.`
        : "- None (leaf package).",
    );
    lines.push(
      "- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).",
    );
  }
  lines.push("");
  const file = `${dir}/AGENTS.md`;
  return [file, replaceBlock(readFileSync(join(root, file), "utf8"), lines.join("\n"), file)];
}

/** Generate updates for the repository's task and package-boundary indexes.
 * @param root - Repository root.
 * @returns Files and their regenerated contents.
 */
export function generate(root) {
  const files = walk(root).map((file) => relative(root, file).split(sep).join("/"));
  const agentsDirs = files
    .filter((file) => file.endsWith("AGENTS.md"))
    .map((file) => dirname(file));
  const layers = parseJson(
    layersSchema,
    readFileSync(join(root, "docs/engineering/layers.json"), "utf8"),
  );
  const packages = validateLayers(layers);
  verifyPackageLayers(root, packages);
  const results = new Map();

  for (const dir of agentsDirs) {
    if (dir !== ".") {
      const [file, contents] = buildAgentBlock({ root, dir, files, agentsDirs, layers });
      results.set(file, contents);
    }
  }

  const conv = "docs/engineering/CONVENTIONS.md";
  const table = ["| Package | May import (`@rovinos/*`) |", "| --- | --- |"];
  for (const name of packages) {
    table.push(
      `| \`${name}\` | ${layers[name].map((d) => `\`${d}\``).join(", ") || "nothing (leaf)"} |`,
    );
  }
  results.set(conv, replaceBlock(readFileSync(join(root, conv), "utf8"), table.join("\n"), conv));

  // Relative links in AGENTS.md / CLAUDE.md must resolve.
  const errors = [];
  for (const file of files.filter((entry) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(entry))) {
    const text = results.get(file) ?? readFileSync(join(root, file), "utf8");
    const refs = [
      ...[...text.matchAll(/\]\(\.{1,2}\/[^)#\s]+/g)].map((match) => match[0].slice(2)),
      ...[...text.matchAll(/`\.{1,2}\/[^`\s]+`/g)].map((match) => match[0].slice(1, -1)),
    ];
    for (const ref of refs) {
      if (!existsSync(resolve(root, dirname(file), ref))) {
        errors.push(`${file}: broken reference ${ref}`);
      }
    }
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  let drift = 0;
  for (const [file, next] of generate(root)) {
    if (readFileSync(join(root, file), "utf8") === next) {
      continue;
    }
    drift++;
    if (check) {
      process.stderr.write(`out of date: ${file}\n`);
    } else {
      writeFileSync(join(root, file), next);
    }
  }
  if (check && drift) {
    process.stderr.write("Run: yarn gen:agents\n");
    process.exitCode = 1;
  }
  if (!check) {
    process.stdout.write(`updated ${drift} file(s)\n`);
  }
}
