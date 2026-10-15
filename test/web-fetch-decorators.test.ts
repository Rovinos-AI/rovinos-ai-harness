// SPDX-License-Identifier: Apache-2.0
import { Id, JsonValue, PiiConfigSchema, SequentialIdGenerator, parseJson } from "@harness/schemas";
import { InMemoryWorkspace, OffloadedStub, OffloadingToolPort } from "@harness/context";
import { AuditingVaultResolver, InMemoryVault } from "@harness/vault";
import { PiiToolPort, Tokenizer } from "@harness/pii";
import { WebFetchResultSchema, MAX_WEB_FETCH_BYTES, WebFetchTool } from "@harness/sandbox";
import { describe, expect, it } from "vitest";

const runId = Id.parse("00000000000000000000000001");
const call = {
  callId: Id.parse("00000000000000000000000002"),
  toolId: "web.fetch",
  args: JsonValue.parse({ url: "https://docs.example.test/page" }),
};
const context = { runId, signal: new AbortController().signal };

function wrap(tool: WebFetchTool) {
  const vault = new InMemoryVault();
  const config = PiiConfigSchema.parse({ defaultAction: "tokenize", detokenize: [] });
  const pii = new PiiToolPort(tool, {
    config,
    tokenizer: new Tokenizer({
      vault,
      policy: config,
      detectors: { detect: () => [] },
    }),
    resolver: new AuditingVaultResolver(vault, () => undefined),
  });
  const workspace = new InMemoryWorkspace();
  const port = new OffloadingToolPort(
    pii,
    workspace,
    { thresholdBytes: 0 },
    new SequentialIdGenerator(),
  );
  return { port, workspace };
}

describe("web.fetch through PII and offloading", () => {
  it("offloads cap-sized escaped text after PII validation", async () => {
    const fetched = WebFetchResultSchema.parse({
      url: "https://docs.example.test/page",
      status: 200,
      contentType: "text/plain",
      text: "\u0000".repeat(340_000),
      truncated: true,
      untrusted: true,
      hiddenTextDropped: 0,
    });
    const tool = new WebFetchTool({ backend: { fetch: () => Promise.resolve(fetched) } });
    const { port, workspace } = wrap(tool);

    const execution = await port.execute(call, context);
    const stub = OffloadedStub.parse(execution.result);
    const content = await workspace.read(`.harness/offload/${stub.$offloaded.handle}.json`);
    const result = parseJson(WebFetchResultSchema, new TextDecoder().decode(content), {
      maxBytes: MAX_WEB_FETCH_BYTES,
    });

    expect(result).toMatchObject({ truncated: true, untrusted: true });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      MAX_WEB_FETCH_BYTES,
    );
  });

  it("keeps binary bytes preview-free and preserves validated fetch metadata", async () => {
    const bytes = Array.from({ length: 700_000 }, () => 255);
    const fetched = WebFetchResultSchema.parse({
      url: "https://docs.example.test/image?synthetic=canary",
      status: 200,
      contentType: "image/png",
      binary: true,
      bytes,
      truncated: false,
      untrusted: true,
    });
    const tool = new WebFetchTool({ backend: { fetch: () => Promise.resolve(fetched) } });
    const { port, workspace } = wrap(tool);

    const execution = await port.execute(call, context);
    const stub = OffloadedStub.parse(execution.result);

    expect(stub.$offloaded.preview).toBe("");
    expect(stub.metadata).toEqual({
      url: "https://docs.example.test/image",
      status: 200,
      contentType: "image/png",
      truncated: false,
      untrusted: true,
    });
    expect(
      new TextDecoder().decode(
        await workspace.read(`.harness/offload/${stub.$offloaded.handle}.json`),
      ),
    ).toBe(JSON.stringify(bytes));
  });
});
