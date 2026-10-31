// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  FakeClock,
  Id,
  PiiPolicySchema,
  RunConfigSchema,
  type Detection,
} from "@rovinos/schemas";
import { InMemoryEventStore } from "@rovinos/store";
import { AuditingVaultResolver, InMemoryVault } from "@rovinos/vault";
import { Tokenizer } from "@rovinos/pii";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeApprovalResolver, createRuntimeInputResolver } from "./runtime-resolvers.js";
import type { ToolPort } from "./ports.js";

const stores: InMemoryEventStore[] = [];
const unusedTool: ToolPort = {
  describe: () => undefined,
  execute: () => Promise.reject(new Error("unused")),
};

function createStore(): InMemoryEventStore {
  const store = new InMemoryEventStore();
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("runtime input and approval resolvers", () => {
  it("passes optional PII and queue dependencies to input resolution", async () => {
    const store = createStore();
    const tokenizer = new Tokenizer({
      detectors: { detect: (_text): readonly Detection[] => [] },
      policy: PiiPolicySchema.parse({}),
      vault: new InMemoryVault(),
    });
    const resolver = new AuditingVaultResolver(
      { resolve: () => Promise.resolve(undefined) },
      () => undefined,
    );
    const queue = {
      enqueue: () => Promise.reject(new Error("input is missing before enqueue")),
    };
    const resolveInput = createRuntimeInputResolver({
      store,
      clock: new FakeClock(1),
      pii: { tokenizer, resolver },
      queue,
    });

    await expect(
      resolveInput(Id.parse("A".repeat(26)), Id.parse("B".repeat(26)), {
        action: "decline",
        principal: Code.parse("cli.test"),
      }),
    ).rejects.toMatchObject({ code: "input_not_found" });
  });

  it("rejects edits when no tool port can apply them", () => {
    const resolveApproval = createRuntimeApprovalResolver({
      options: {
        config: { run: RunConfigSchema.parse({}) },
        overrides: {},
      },
      store: createStore(),
      clock: new FakeClock(1),
      tool: unusedTool,
    });

    expect(() =>
      resolveApproval(Id.parse("A".repeat(26)), Id.parse("B".repeat(26)), "edit", {
        edits: {},
      }),
    ).toThrow(expect.objectContaining({ code: "approval_edit_unavailable" }));
  });

  it("delegates an approval resolution after ownership and edit checks pass", async () => {
    const resolveApproval = createRuntimeApprovalResolver({
      options: {
        config: { run: RunConfigSchema.parse({}) },
        overrides: { tool: unusedTool },
      },
      store: createStore(),
      clock: new FakeClock(1),
      tool: unusedTool,
    });

    await expect(
      resolveApproval(Id.parse("A".repeat(26)), Id.parse("B".repeat(26)), "approve"),
    ).rejects.toBeDefined();
  });

  it("checks runtime ownership before resolving approvals", () => {
    const controller = new AbortController();
    controller.abort("deployment_single_instance_violation");
    const resolveApproval = createRuntimeApprovalResolver({
      options: {
        config: { run: RunConfigSchema.parse({}) },
        overrides: {},
        instanceHeartbeat: { signal: controller.signal, close: () => Promise.resolve() },
      },
      store: createStore(),
      clock: new FakeClock(1),
      tool: unusedTool,
    });

    expect(() =>
      resolveApproval(Id.parse("A".repeat(26)), Id.parse("B".repeat(26)), "approve"),
    ).toThrow(expect.objectContaining({ code: "deployment_single_instance_violation" }));
  });
});
