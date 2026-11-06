// SPDX-License-Identifier: Apache-2.0
import * as http from "node:http";
import { expect, it, vi } from "vitest";
import { startLiveModelGateway } from "./live-model-gateway.js";

vi.mock("node:http", { spy: true });

it("does not apply the request-body timeout while a duplex call is awaiting inference", async () => {
  const listen = vi.mocked(http.createServer);
  const gateway = await startLiveModelGateway({
    complete: () => Promise.reject(new Error("synthetic_unused")),
  });
  try {
    const created = listen.mock.results.at(-1);
    if (created?.type !== "return") {
      throw new Error("expected_server");
    }
    expect(created.value.requestTimeout).toBe(0);
    expect(created.value.headersTimeout).toBe(10_000);
  } finally {
    await gateway.close();
    listen.mockClear();
  }
});
