// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { parseJson } from "@rovinos/schemas";
import * as incubatingSemconv from "@opentelemetry/semantic-conventions/incubating";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  MCP_METHOD_NAME,
  SEMCONV_ATTRIBUTE_NAMES,
  SEMCONV_VERSION,
} from "./semconv.js";

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

    const pinnedMcpMethodName: unknown = Reflect.get(incubatingSemconv, "ATTR_MCP_METHOD_NAME");
    expect(manifest.dependencies["@opentelemetry/semantic-conventions"]).toBe(SEMCONV_VERSION);
    expect(MCP_METHOD_NAME).toBe(pinnedMcpMethodName);
    expect(SEMCONV_ATTRIBUTE_NAMES).toEqual([
      pinnedMcpMethodName,
      Reflect.get(incubatingSemconv, "ATTR_GEN_AI_PROVIDER_NAME"),
      Reflect.get(incubatingSemconv, "ATTR_GEN_AI_REQUEST_MODEL"),
      Reflect.get(incubatingSemconv, "ATTR_GEN_AI_USAGE_INPUT_TOKENS"),
      Reflect.get(incubatingSemconv, "ATTR_GEN_AI_USAGE_OUTPUT_TOKENS"),
      Reflect.get(incubatingSemconv, "ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS"),
      Reflect.get(incubatingSemconv, "ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS"),
    ]);
    expect([
      GEN_AI_PROVIDER_NAME,
      GEN_AI_REQUEST_MODEL,
      GEN_AI_USAGE_INPUT_TOKENS,
      GEN_AI_USAGE_OUTPUT_TOKENS,
      GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
      GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
    ]).toEqual(SEMCONV_ATTRIBUTE_NAMES.slice(1));
  });
});
