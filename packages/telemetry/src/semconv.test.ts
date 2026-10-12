// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { parseJson } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MCP_METHOD_NAME, SEMCONV_VERSION } from "./semconv.js";

const PackageManifestSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()),
  })
  .loose();

describe("OpenTelemetry semantic conventions", () => {
  it("pins the package version and verifies the MCP attribute against it", () => {
    const manifest = parseJson(
      PackageManifestSchema,
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(manifest.dependencies["@opentelemetry/semantic-conventions"]).toBe(SEMCONV_VERSION);
    expect(MCP_METHOD_NAME).toBe("mcp.method.name");
  });
});
