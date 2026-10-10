// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsConfigSchema } from "@harness/schemas";
import { RoleRegistry, RoleRegistryError, resolveRole } from "./roles.js";

const directoryPrefix = join(tmpdir(), "harness-roles-");
const directories: string[] = [];

async function configDirectory(): Promise<string> {
  const directory = await mkdtemp(directoryPrefix);
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function models(): ReturnType<typeof ModelsConfigSchema.parse> {
  return ModelsConfigSchema.parse({
    routing: {
      roles: {
        planner: [{ provider: "local", model: "model" }],
        worker: [{ provider: "local", model: "model" }],
        judge: [{ provider: "local", model: "model" }],
        summarizer: [{ provider: "local", model: "model" }],
        fast: [{ provider: "local", model: "model" }],
      },
    },
  });
}

async function registry(
  directory: string,
  roles: readonly unknown[] = [],
  options: Partial<Parameters<typeof RoleRegistry.create>[0]> = {},
): Promise<RoleRegistry> {
  return RoleRegistry.create({
    roles,
    models: models(),
    registeredTools: ["fs.read", "fs.write", "mail.send"],
    contextStrategies: new Set(["naive"]),
    configDirectory: directory,
    ...options,
  });
}

describe("RoleRegistry", () => {
  it("provides safe built-ins and allows configured roles to override them", async () => {
    const roleRegistry = await registry(await configDirectory(), [
      { id: "worker", route: "fast", tools: ["fs.read"], maxDepth: 1 },
    ]);

    expect(roleRegistry.resolveRole("judge").tools).toEqual([]);
    expect(roleRegistry.resolveRole("summarizer").tools).toEqual([]);
    expect(roleRegistry.resolveRole("worker")).toMatchObject({
      id: "worker",
      route: "fast",
      tools: ["fs.read"],
      maxDepth: 1,
      maxChildren: 8,
    });
    expect(resolveRole("planner", roleRegistry).tools).toEqual([
      "fs.read",
      "fs.write",
      "mail.send",
    ]);
  });

  it("uses default routing when no role routes are configured", async () => {
    const roleRegistry = await registry(await configDirectory(), [], {
      models: ModelsConfigSchema.parse({
        routing: { default: [{ provider: "local", model: "model" }] },
      }),
    });

    expect(roleRegistry.resolveRole("planner").route).toBeUndefined();
    expect(roleRegistry.resolveRole("worker").route).toBeUndefined();
  });

  it("expands globs, deduplicates matching tools, and warns for unmatched patterns", async () => {
    const onWarning = vi.fn();
    const roleRegistry = await registry(
      await configDirectory(),
      [{ id: "worker", tools: ["fs.*", "missing.*"] }],
      { onWarning },
    );

    expect(roleRegistry.resolveRole("worker").tools).toEqual(["fs.read", "fs.write"]);
    expect(roleRegistry.warnings).toEqual([
      { code: "role_tool_pattern_unmatched", roleId: "worker", pattern: "missing.*" },
    ]);
    expect(onWarning).toHaveBeenCalledWith(roleRegistry.warnings[0]);
  });

  it("rejects duplicate ids and invalid role configuration", async () => {
    const directory = await configDirectory();
    await expect(
      registry(directory, [
        { id: "worker", tools: [] },
        { id: "worker", tools: [] },
      ]),
    ).rejects.toMatchObject({ code: "role_id_duplicate" });
    await expect(
      registry(directory, [{ id: "worker", tools: ["Invalid Tool"] }]),
    ).rejects.toMatchObject({ code: "role_config_invalid" });
  });

  it("fails startup for unknown routes and context strategies", async () => {
    const directory = await configDirectory();
    await expect(
      registry(directory, [{ id: "worker", route: "missing", tools: [] }]),
    ).rejects.toMatchObject({ code: "role_route_unknown" });
    await expect(
      registry(directory, [{ id: "worker", tools: [], contextStrategy: "missing" }]),
    ).rejects.toMatchObject({ code: "role_context_strategy_unknown" });
  });

  it("reads prompt files inside the config directory and rejects traversal", async () => {
    const directory = await configDirectory();
    await mkdir(join(directory, "prompts"));
    await writeFile(join(directory, "prompts", "worker.md"), "trusted operator prompt");

    const roleRegistry = await registry(directory, [
      { id: "worker", tools: [], systemPrompt: { file: "prompts/worker.md" } },
    ]);
    expect(roleRegistry.resolveRole("worker").systemPrompt).toBe("trusted operator prompt");

    await expect(
      registry(directory, [{ id: "worker", tools: [], systemPrompt: { file: "../outside.md" } }]),
    ).rejects.toMatchObject({ code: "role_prompt_path_invalid" });
  });

  it("rejects prompt files larger than 8,000 characters without exposing their contents", async () => {
    const directory = await configDirectory();
    await writeFile(join(directory, "large.md"), "sensitive prompt".padEnd(8_001, "!"));

    await expect(
      registry(directory, [{ id: "worker", tools: [], systemPrompt: { file: "large.md" } }]),
    ).rejects.toMatchObject({
      code: "role_prompt_too_large",
      message: "Role configuration failed (role_prompt_too_large).",
    });
  });

  it("rejects symlink escapes and reports unreadable prompt files", async () => {
    const directory = await configDirectory();
    const externalDirectory = await configDirectory();
    await writeFile(join(externalDirectory, "outside.md"), "outside");
    await symlink(externalDirectory, join(directory, "escape"));

    await expect(
      registry(directory, [
        { id: "worker", tools: [], systemPrompt: { file: "escape/outside.md" } },
      ]),
    ).rejects.toMatchObject({ code: "role_prompt_path_invalid" });
    await expect(
      registry(directory, [{ id: "worker", tools: [], systemPrompt: { file: "missing.md" } }]),
    ).rejects.toMatchObject({ code: "role_prompt_unavailable" });
  });

  it("loads exported Zod result schemas and rejects module failures", async () => {
    const directory = await configDirectory();
    const schema = (await import("zod")).z.string();
    const roleRegistry = await registry(
      directory,
      [{ id: "worker", tools: [], resultSchema: "./schema.js#Result" }],
      { loadSchema: () => Promise.resolve({ Result: schema }) },
    );
    expect(roleRegistry.resolveRole("worker").resultSchema).toBe(schema);

    await expect(
      registry(directory, [{ id: "worker", tools: [], resultSchema: "./missing.js#Result" }]),
    ).rejects.toMatchObject({ code: "role_result_schema_invalid" });
    await expect(
      registry(directory, [{ id: "worker", tools: [], resultSchema: "./schema.js#Missing" }], {
        loadSchema: () => Promise.resolve({}),
      }),
    ).rejects.toMatchObject({ code: "role_result_schema_invalid" });
    await expect(
      registry(directory, [{ id: "worker", tools: [], resultSchema: "missing-export" }]),
    ).rejects.toMatchObject({ code: "role_result_schema_invalid" });
    await expect(
      registry(directory, [{ id: "worker", tools: [], resultSchema: "./not-zod.js#Schema" }], {
        loadSchema: () => Promise.resolve({ Schema: "not a schema" }),
      }),
    ).rejects.toMatchObject({ code: "role_result_schema_invalid" });
  });

  it("accepts result schemas from a separate Zod module copy", async () => {
    const directory = await configDirectory();
    const schema = { _zod: {}, safeParse: () => ({ success: true }) };
    const roleRegistry = await registry(
      directory,
      [{ id: "worker", tools: [], resultSchema: "./schema.js#Result" }],
      { loadSchema: () => Promise.resolve({ Result: schema }) },
    );

    expect(roleRegistry.resolveRole("worker").resultSchema).toBe(schema);
    expect(Object.isFrozen(schema)).toBe(false);
  });

  it("returns deeply frozen role data and reports missing names", async () => {
    const roleRegistry = await registry(await configDirectory(), [
      { id: "worker", tools: ["fs.*"], budgets: { maxSteps: 3 } },
    ]);
    const resolved = roleRegistry.resolveRole("worker");

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.tools)).toBe(true);
    expect(Object.isFrozen(resolved.budgets)).toBe(true);
    expect(() => resolveRole("unknown", roleRegistry)).toThrow(RoleRegistryError);
    expect(() => roleRegistry.resolveRole("unknown")).toThrow(
      "Role configuration failed (role_not_found).",
    );
  });
});
