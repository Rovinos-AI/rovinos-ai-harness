// SPDX-License-Identifier: Apache-2.0
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { JsonValue, parseJson } from "@harness/schemas";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sends baggage in raw MCP metadata and reports whether the sample server received it. */
export async function baggageTrace(serverUrl) {
  const client = new Client({ name: "sample-mcp-baggage-probe", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));
    const result = await client.callTool({
      name: "trace_probe",
      arguments: {},
      _meta: { baggage: "synthetic=value" },
    });
    const first = result.content[0];
    if (first?.type !== "text") {
      throw new TypeError("The sample MCP server returned a non-text baggage probe result.");
    }
    const probeValue = parseJson(JsonValue, first.text);
    return { hasBaggage: isRecord(probeValue) && probeValue.hasBaggage === true };
  } finally {
    await client.close();
  }
}

/** Scans exported span attributes, events, and links for a test canary. */
export function spansContainCanary(spans, canary) {
  return JSON.stringify(
    spans.map(({ name, attributes, status, events, links }) => ({
      name,
      attributes,
      status,
      events,
      links,
    })),
  ).includes(canary);
}
