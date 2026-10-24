// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { BedrockAdapter } from "./bedrock.js";
import type { ModelRequest } from "@rovinos/schemas";

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const modelId = process.env.BEDROCK_MODEL_ID;
const hasCredentialSource =
  (process.env.AWS_ACCESS_KEY_ID !== undefined &&
    process.env.AWS_SECRET_ACCESS_KEY !== undefined) ||
  process.env.AWS_PROFILE !== undefined ||
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI !== undefined ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI !== undefined;

describe.skipIf(region === undefined || modelId === undefined || !hasCredentialSource)(
  "LIVE Amazon Bedrock Converse",
  () => {
    it("completes a minimal request using the AWS default credential chain", async () => {
      if (region === undefined || modelId === undefined) {
        return;
      }
      const adapter = new BedrockAdapter({
        region,
        modelIds: { live: modelId },
      });
      const request: ModelRequest = {
        requestId: "00000000000000000000000000",
        model: { provider: "bedrock", model: "live" },
        messages: [{ role: "user", parts: [{ type: "text", text: "Reply with one word." }] }],
        maxOutputTokens: 16,
      };
      const result = await adapter.complete(request, {
        signal: new AbortController().signal,
        ids: { next: () => request.requestId },
        clock: { now: () => Date.now() },
      });
      expect(result.parts.some((part) => part.type === "text")).toBe(true);
    });
  },
);
