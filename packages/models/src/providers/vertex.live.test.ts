// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "@rovinos/schemas";
import { VertexAdapter } from "./vertex.js";

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION;
const model = process.env.VERTEX_MODEL;
const hasVertexConfig =
  project !== undefined &&
  project.length > 0 &&
  location !== undefined &&
  location.length > 0 &&
  model !== undefined &&
  model.length > 0;

function requireVertexConfig(): {
  readonly project: string;
  readonly location: string;
  readonly model: string;
} {
  if (!hasVertexConfig) {
    throw new Error("vertex_live_configuration_required");
  }
  return { project, location, model };
}

describe.skipIf(!hasVertexConfig)("LIVE Vertex AI Gemini", () => {
  it("completes a minimal request with Application Default Credentials", async () => {
    const config = requireVertexConfig();
    const request: ModelRequest = {
      requestId: "00000000000000000000000000",
      model: { provider: "vertex", model: config.model },
      messages: [{ role: "user", parts: [{ type: "text", text: "Reply with one word." }] }],
      maxOutputTokens: 16,
    };
    const result = await new VertexAdapter({
      project: config.project,
      location: config.location,
    }).complete(request, {
      signal: new AbortController().signal,
      ids: { next: () => request.requestId },
      clock: { now: () => 0 },
    });

    expect(result.parts.some((part) => part.type === "text")).toBe(true);
  });
});
