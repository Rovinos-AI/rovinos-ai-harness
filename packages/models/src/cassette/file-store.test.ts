// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError, type ModelRequest } from "@harness/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderResult } from "../types.js";
import { FileCassetteStore } from "./file-store.js";

const request: ModelRequest = {
  requestId: "00000000000000000000000001",
  model: { provider: "cassette", model: "test" },
  messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
};
const firstResult: ProviderResult = {
  parts: [{ type: "text", text: "first" }],
  usage: { inputTokens: 1, outputTokens: 2 },
  finishReason: "stop",
  latencyMs: 3,
};
const secondResult: ProviderResult = {
  parts: [{ type: "text", text: "second" }],
  usage: { inputTokens: 4, outputTokens: 5 },
  finishReason: "stop",
  latencyMs: 6,
};
const firstHash = "a".repeat(64);
const secondHash = "b".repeat(64);

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "harness-cassette-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("FileCassetteStore", () => {
  it("writes sorted entries in the stable golden format and reads them back", async () => {
    const path = join(directory, "scenario.json");
    const store = new FileCassetteStore(path);
    await store.set({ hash: secondHash, response: secondResult });
    await store.set({ hash: firstHash, response: firstResult });

    expect(await readFile(path, "utf8")).toBe(
      await readFile(new URL("./__golden__/cassette.json", import.meta.url), "utf8"),
    );
    expect(await store.get(firstHash, request)).toEqual(firstResult);
    expect(await new FileCassetteStore(path).get(secondHash, request)).toEqual(secondResult);
  });

  it("starts empty when the scenario file does not exist", async () => {
    const store = new FileCassetteStore(join(directory, "missing.json"));

    expect(await store.get(firstHash, request)).toBeUndefined();
  });

  it("rejects files without the false real-data declaration", async () => {
    const path = join(directory, "unsafe.json");
    await writeFile(path, JSON.stringify({ containsRealData: true, entries: [] }), "utf8");

    await expect(new FileCassetteStore(path).get(firstHash, request)).rejects.toBeInstanceOf(
      ContractError,
    );
  });
});
