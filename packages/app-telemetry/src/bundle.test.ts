// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const entryPoint = new URL("./index.ts", import.meta.url).pathname;

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
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error("esbuild did not produce an IIFE bundle");
  }
  return output.text;
}

describe("app telemetry browser bundle", () => {
  it("stays under the 4 KB gzip budget", async () => {
    const bundle = await buildIife();
    expect(gzipSync(bundle).byteLength).toBeLessThan(4 * 1024);
  });

  it("contains no direct network APIs", async () => {
    const bundle = await buildIife();
    for (const identifier of ["fetch", "XMLHttpRequest", "WebSocket", "sendBeacon"]) {
      expect(bundle).not.toMatch(new RegExp(`\\b${identifier}\\b`, "u"));
    }
  });
});
