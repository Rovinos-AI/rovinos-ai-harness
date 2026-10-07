#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Regenerates the index blocks in every folder AGENTS.md and the dependency table in CONVENTIONS section 1.
// Inputs: epic-*.md headings, TASKS.md "Task ids:" lines, docs/engineering/layers.json.
// Usage: node scripts/gen-agents-index.mjs [--check]
// Dependency-free Node 22 ESM so it runs without installing anything; task 1.1 wires it as `pnpm gen:agents` / `pnpm check:agents`.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BEGIN = "<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->";
const END = "<!-- END GENERATED: agents-index -->";
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".claude"]);

/** Compress task ids into ranges: ["2.1","2.2","2.3","4.1"] -> "2.1-2.3, 4.1". */
export function compressIds(ids) {
  const parsed = ids.map((id) => id.split(".").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  let start = null;
  let prev = null;
  const flush = () => {
    if (start) out.push(start === prev ? start.join(".") : `${start.join(".")}-${prev.join(".")}`);
  };
  for (const p of parsed) {
    if (prev && p[0] === prev[0] && p[1] === prev[1] + 1) {
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
      if (!names.includes(dep)) throw new Error(`layers.json: ${name} imports unknown package ${dep}`);
      if (dep === name) throw new Error(`layers.json: ${name} imports itself`);
    }
  }
  const state = new Map();
  const visit = (name, path) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "active") throw new Error(`layers.json: cycle ${[...path, name].join(" -> ")}`);
    state.set(name, "active");
    for (const dep of layers[name]) visit(dep, [...path, name]);
    state.set(name, "done");
  };
  for (const name of names) visit(name, []);
  return names;
}

export function replaceBlock(text, body, file) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error(`${file}: missing generated block markers`);
  return `${text.slice(0, a + BEGIN.length)}\n${body}\n${text.slice(b)}`;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function generate(root) {
  const files = walk(root).map((f) => relative(root, f).split(sep).join("/"));
  const agentsDirs = files.filter((f) => f.endsWith("AGENTS.md")).map((f) => dirname(f));
  const layers = JSON.parse(readFileSync(join(root, "docs/engineering/layers.json"), "utf8"));
  const packages = validateLayers(layers);
  for (const dir of readdirSync(join(root, "packages"))) {
    if (statSync(join(root, "packages", dir)).isDirectory() && !packages.includes(dir)) {
      throw new Error(`layers.json: no entry for packages/${dir}`);
    }
  }

  // Each spec file belongs to the nearest folder that has an AGENTS.md.
  const owner = (file) => {
    let d = dirname(file);
    while (!agentsDirs.includes(d)) d = d === "." ? null : dirname(d);
    return d;
  };
  const results = new Map();

  for (const dir of agentsDirs) {
    if (dir === ".") continue;
    const owned = files.filter((f) => owner(f) === dir).sort();
    const lines = ["## Specs and task ids"];
    for (const f of owned.filter((f) => /(^|\/)epic-[^/]+\.md$/.test(f))) {
      const ids = [...readFileSync(join(root, f), "utf8").matchAll(/^## (\d+\.\d+)\b/gm)].map((m) => m[1]);
      lines.push(`- [${relative(dir, f)}](./${relative(dir, f)}): tasks ${compressIds(ids)}`);
    }
    for (const f of owned.filter((f) => f.endsWith("/TASKS.md") || f === "TASKS.md")) {
      const m = readFileSync(join(root, f), "utf8").match(/^Task ids: (.+)$/m);
      if (!m) throw new Error(`${f}: missing "Task ids:" line`);
      lines.push(`- [${relative(dir, f)}](./${relative(dir, f)}) (specs in other folders): tasks ${m[1]}`);
    }
    if (lines.length === 1) lines.push("- None. See `docs/engineering/tasks/README.md`.");
    const pkg = dir.match(/^packages\/([^/]+)$/);
    if (pkg) {
      const deps = layers[pkg[1]];
      lines.push("", "## Allowed internal imports");
      lines.push(
        deps.length
          ? `- ${deps.map((d) => `\`@harness/${d}\``).join(", ")}. Nothing else from \`@harness/*\`.`
          : "- None (leaf package).",
      );
      lines.push("- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).");
    }
    const file = `${dir}/AGENTS.md`;
    results.set(file, replaceBlock(readFileSync(join(root, file), "utf8"), lines.join("\n"), file));
  }

  const conv = "docs/engineering/CONVENTIONS.md";
  const table = ["| Package | May import (`@harness/*`) |", "|---|---|"];
  for (const name of packages) table.push(`| \`${name}\` | ${layers[name].map((d) => `\`${d}\``).join(", ") || "nothing (leaf)"} |`);
  results.set(conv, replaceBlock(readFileSync(join(root, conv), "utf8"), table.join("\n"), conv));

  // Relative links in AGENTS.md / CLAUDE.md must resolve.
  const errors = [];
  for (const f of files.filter((f) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(f))) {
    const text = results.get(f) ?? readFileSync(join(root, f), "utf8");
    const refs = [
      ...[...text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)].map((m) => m[1]),
      ...[...text.matchAll(/`(\.{1,2}\/[^`\s]+)`/g)].map((m) => m[1]),
    ];
    for (const ref of refs) {
      if (!existsSync(resolve(root, dirname(f), ref))) errors.push(`${f}: broken reference ${ref}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  let drift = 0;
  for (const [file, next] of generate(root)) {
    if (readFileSync(join(root, file), "utf8") === next) continue;
    drift++;
    if (check) console.error(`out of date: ${file}`);
    else writeFileSync(join(root, file), next);
  }
  if (check && drift) {
    console.error("Run: node scripts/gen-agents-index.mjs");
    process.exit(1);
  }
  if (!check) console.log(`updated ${drift} file(s)`);
}
