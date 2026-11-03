// SPDX-License-Identifier: Apache-2.0
// Request state deliberately includes non-ASCII and control bytes to detect lossy retries.
import type {
  CallToolRequest,
  CallToolResult,
  ServerContext,
  Tool,
} from "@modelcontextprotocol/server";
import { z } from "zod";

export const SAMPLE_REQUEST_STATE = "sample-state:\u0000:💡:\r\n";
export const confirmationForm = {
  mode: "form" as const,
  message: "Confirm the synthetic action.",
  requestedSchema: {
    type: "object" as const,
    properties: { confirmed: { type: "boolean" as const } },
    required: ["confirmed"],
  },
};
export const accountUrl = {
  mode: "url" as const,
  message: "Connect the synthetic account in your own browser.",
  url: "https://accounts.example.test/connect",
  elicitationId: "account",
};
export const sampleInputTools = [
  "confirm_action",
  "connect_account",
  "confirm_action_legacy",
  "connect_account_legacy",
].map((name) => ({
  name,
  description: "Synthetic human input fixture.",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
})) satisfies Tool[];

/** Handles the sample input tools; leaves unrelated sample tools to their existing handlers. */
export async function sampleInputTool(
  request: CallToolRequest,
  extra: ServerContext,
): Promise<CallToolResult | undefined> {
  const name = request.params.name;
  if (!sampleInputTools.some((tool) => tool.name === name)) {
    return undefined;
  }
  const params = name.startsWith("confirm_action") ? confirmationForm : accountUrl;
  if (name.endsWith("_legacy")) {
    const response = await extra.mcpReq.send({ method: "elicitation/create", params });
    return { content: [{ type: "text", text: response.action }] };
  }
  if (extra.mcpReq.inputResponses !== undefined) {
    const responses = z
      .record(z.string(), z.object({ action: z.string() }).loose())
      .parse(extra.mcpReq.inputResponses);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            action: Object.values(responses)[0]?.action,
            stateUnchanged: extra.mcpReq.requestState() === SAMPLE_REQUEST_STATE,
          }),
        },
      ],
    };
  }
  const urlParams = { mode: accountUrl.mode, message: accountUrl.message, url: accountUrl.url };
  return {
    content: [],
    resultType: "input_required",
    inputRequests: {
      human: {
        method: "elicitation/create",
        params: name === "confirm_action" ? confirmationForm : urlParams,
      },
    },
    requestState: SAMPLE_REQUEST_STATE,
  };
}
