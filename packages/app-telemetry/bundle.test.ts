// SPDX-License-Identifier: Apache-2.0
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const entryPoint = new URL("./src/index.ts", import.meta.url).pathname;

async function buildIife(): Promise<string> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "HarnessAppTelemetry",
    target: "es2022",
    minify: true,
    write: false,
  });
  return result.outputFiles[0]?.text ?? "";
}

async function gzipSize(bundle: string): Promise<number> {
  const compressed = new Blob([bundle]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(compressed).arrayBuffer()).byteLength;
}

describe("app telemetry browser bundle", () => {
  it("stays under the 4 KB gzip budget", async () => {
    const bundle = await buildIife();
    expect(bundle).not.toBe("");
    expect(await gzipSize(bundle)).toBeLessThan(4 * 1024);
  });

  it("contains no direct network APIs", async () => {
    const bundle = await buildIife();
    expect(bundle).not.toBe("");
    for (const identifier of ["fetch", "XMLHttpRequest", "WebSocket", "sendBeacon"]) {
      expect(bundle).not.toMatch(new RegExp(`\\b${identifier}\\b`, "u"));
    }
  });
});
