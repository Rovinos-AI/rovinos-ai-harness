// SPDX-License-Identifier: Apache-2.0
import { Code, FakeClock, Id, SequentialIdGenerator } from "@rovinos/schemas";
import { allowAllPolicy } from "@rovinos/core/testing";
import type { ModelCompletion, ModelPort, RunContext } from "@rovinos/core";
import { HarnessConfigSchema } from "@rovinos/config";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionError,
  ExtensionManifestSchema,
  ExtensionRegistrationSchema,
  SDK_VERSION,
  ProviderResultSchema,
  createHarness,
  defineTool,
} from "./index.js";
import type {
  ExtensionCapability,
  ExtensionDefinition,
  ExtensionGrant,
  ExtensionRegistration,
  ToolInvocationContext,
  ProviderAdapter,
} from "./index.js";
import { prepareExtensions } from "./extensions.js";
import { InMemoryEventStore } from "@rovinos/store";
import { z } from "zod";

const configSchema = z.object({ label: z.string().min(1).max(40) }).strict();
const inputSchema = z.object({ query: z.string().min(1).max(40) }).strict();
const outputSchema = z.object({ answer: z.string().max(80) }).strict();

function definition(capabilities: {
  readonly required?: readonly ExtensionCapability[];
  readonly optional?: readonly ExtensionCapability[];
  readonly createContributions?: ExtensionDefinition<typeof configSchema>["createContributions"];
} = {}): ExtensionDefinition<typeof configSchema> {
  return {
    manifest: {
      id: "sample.search",
      version: "1.0.0",
      sdkRange: ">=0.3.0 <0.4.0",
      schemaVersion: 1,
      capabilities: {
        required: [...(capabilities.required ?? [])],
        optional: [...(capabilities.optional ?? [])],
      },
    },
    configSchema,
    createContributions:
      capabilities.createContributions ??
      (() => ({
        tools: [
          defineTool({
            name: "search",
            description: "Search the synthetic source.",
            inputSchema,
            outputSchema,
            execute: ({ query }) => Promise.resolve({ answer: query }),
          }),
        ],
      })),
  };
}

function registration(
  definitionValue: ExtensionDefinition<typeof configSchema>,
  grants: ExtensionRegistration["grants"] = [],
  config: z.input<typeof configSchema> = { label: "synthetic" },
): ExtensionRegistration<typeof definitionValue> {
  return {
    namespace: "knowledge",
    definition: definitionValue,
    config,
    grants,
  };
}

const toolGrant: ExtensionGrant = { kind: "tools.contribute", names: ["search"] };
const providerGrant: ExtensionGrant = {
  kind: "providers.contribute",
  providers: ["sample.provider"],
};

const toolCall = {
  callId: Id.parse("00000000000000000000000001"),
  toolId: Code.parse("knowledge.search"),
  args: { query: "refund" },
};

const toolContext: RunContext = {
  runId: Id.parse("00000000000000000000000002"),
  signal: new AbortController().signal,
};

describe("SDK extension registration", () => {
  it("uses the manifest schema and rejects incompatible SDK ranges", () => {
    expect(SDK_VERSION).toBe("0.3.0");
    expect(
      ExtensionManifestSchema.safeParse({
        id: "sample.search",
        version: "1.0.0",
        sdkRange: ">=0.3.0 <1.0.0",
        schemaVersion: 1,
        capabilities: { required: [], optional: [] },
      }).success,
    ).toBe(true);

    expect(() =>
      prepareExtensions(
        [
          registration(
            definition({
              required: [{ kind: "tools.contribute", names: ["search"] }],
            }),
          ),
        ],
        undefined,
        [],
      ),
    ).toThrow(new ExtensionError("extension_grant_missing"));

    const compatibleDefinition = definition();
    const incompatible = registration({
      ...compatibleDefinition,
      manifest: { ...compatibleDefinition.manifest, sdkRange: ">=99.0.0 <100.0.0" },
    });
    expect(() => prepareExtensions([incompatible], undefined, [])).toThrow(
      new ExtensionError("extension_incompatible"),
    );
  });

  it("validates config and required grants before calling extension code", () => {
    const createContributions = vi.fn(() => ({ tools: [] }));
    const candidate = registration(
      definition({
        required: [{ kind: "tools.contribute", names: ["search"] }],
        createContributions,
      }),
      [],
      { label: "" },
    );

    expect(() => prepareExtensions([candidate], undefined, [])).toThrow(
      new ExtensionError("extension_grant_missing"),
    );
    expect(createContributions).not.toHaveBeenCalled();

    const grantedCandidate = registration(
      candidate.definition,
      [toolGrant],
      { label: "" },
    );
    expect(() => prepareExtensions([grantedCandidate], undefined, [])).toThrow(
      new ExtensionError("extension_config_invalid"),
    );
    expect(createContributions).not.toHaveBeenCalled();
  });

  it("reports unsupported optional capabilities and disables contributions that are not granted", () => {
    const createContributions = vi.fn(() => ({ tools: [] }));
    const prepared = prepareExtensions(
      [
        registration(
          definition({
            optional: [
              { kind: "tools.contribute", names: ["search"] },
              { kind: "events.observe", kinds: ["tool_call"] },
            ],
            createContributions,
          }),
        ),
      ],
      undefined,
      [],
    );

    expect(prepared.tool?.getToolSpecs?.() ?? []).toEqual([]);
    expect(createContributions).not.toHaveBeenCalled();
    expect(prepared.getStatuses()[0]?.capabilities).toEqual([
      {
        kind: "tools.contribute",
        requested: ["search"],
        enabled: [],
        unsupported: ["search"],
        reason: "not_granted",
      },
      {
        kind: "events.observe",
        requested: ["tool_call"],
        enabled: [],
        unsupported: ["tool_call"],
        reason: "not_implemented",
      },
    ]);
  });

  it("rejects unsupported required capabilities and bounded-configuration violations", () => {
    expect(() =>
      prepareExtensions(
        [
          registration(
            definition({
              required: [{ kind: "events.observe", kinds: ["tool_call"] }],
            }),
          ),
        ],
        undefined,
        [],
      ),
    ).toThrow(new ExtensionError("extension_capability_unsupported"));

    expect(
      ExtensionRegistrationSchema.safeParse(
        registration(definition(), [], { label: "x".repeat(65 * 1024) }),
      ).success,
    ).toBe(false);
    expect(
      ExtensionRegistrationSchema.safeParse({
        ...registration(definition()),
        toolTimeoutMs: 30_001,
      }).success,
    ).toBe(false);
    expect(
      ExtensionRegistrationSchema.safeParse({
        ...registration(definition()),
        maxOutputBytes: 65 * 1024,
      }).success,
    ).toBe(false);
  });

  it("rejects input schemas that cannot be represented in the model-facing JSON Schema", () => {
    const transformedSchema = z.string().transform((value) => value);
    expect(() =>
      prepareExtensions(
        [
          registration(
            definition({
              required: [{ kind: "tools.contribute", names: ["search"] }],
              createContributions: () => ({
                tools: [
                  defineTool({
                    name: "search",
                    description: "Search the synthetic source.",
                    inputSchema: transformedSchema,
                    outputSchema,
                    execute: (value) => Promise.resolve({ answer: value }),
                  }),
                ],
              }),
            }),
            [toolGrant],
          ),
        ],
        undefined,
        [],
      ),
    ).toThrow(new ExtensionError("extension_schema_unsupported"));
  });

  it("validates direct tool contributions, executes them through a narrow context, and rechecks revocation", async () => {
    const prepared = prepareExtensions(
      [
        registration(
          definition({
            required: [{ kind: "tools.contribute", names: ["search"] }],
          }),
          [toolGrant],
        ),
      ],
      undefined,
      [],
    );
    const tool = prepared.tool;
    if (tool === undefined) {
      throw new Error("The granted extension tool should be registered.");
    }
    expect(tool.getToolSpecs?.()).toHaveLength(1);
    expect(tool.describe(Code.parse("knowledge.search"))).toMatchObject({
      idempotent: false,
      timeoutMs: 30_000,
    });
    await expect(tool.execute(toolCall, toolContext)).resolves.toMatchObject({
      outcome: "ok",
      result: { answer: "refund" },
    });
    expect(tool.catalogFingerprints?.()).toHaveProperty("knowledge.search");
    await expect(
      tool.execute({ ...toolCall, args: { query: "" } }, toolContext),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "extension_input_invalid" });

    expect(
      prepared.revokeGrant({
        namespace: "knowledge",
        kind: "tools.contribute",
        target: "search",
      }),
    ).toBe(true);
    expect(tool.getToolSpecs?.()).toEqual([]);
    expect(tool.catalogFingerprints?.()).toEqual({});
    expect(prepared.getStatuses()[0]?.capabilities[0]).toMatchObject({
      enabled: [],
      unsupported: ["search"],
      reason: "not_granted",
    });
    await expect(tool.execute(toolCall, toolContext)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "extension_grant_missing",
    });
  });

  it("uses the lower of the operator tool timeout and the run wall-clock budget", () => {
    const registrationWithTimeout = {
      ...registration(
        definition({ required: [{ kind: "tools.contribute", names: ["search"] }] }),
        [toolGrant],
      ),
      toolTimeoutMs: 20_000,
    };
    const prepared = prepareExtensions(
      [registrationWithTimeout],
      undefined,
      [],
      5_000,
    );
    expect(prepared.tool?.describe(Code.parse("knowledge.search"))?.timeoutMs).toBe(5_000);
  });

  it("stops a cancelled invocation and rejects invalid output without forwarding it", async () => {
    const execute = vi.fn(() => Promise.resolve({ answer: "x".repeat(81) }));
    const prepared = prepareExtensions(
      [
        registration(
          definition({
            required: [{ kind: "tools.contribute", names: ["search"] }],
            createContributions: () => ({
              tools: [
                defineTool({
                  name: "search",
                  description: "Search the synthetic source.",
                  inputSchema,
                  outputSchema,
                  execute,
                }),
              ],
            }),
          }),
          [toolGrant],
        ),
      ],
      undefined,
      [],
    );
    const tool = prepared.tool;
    await expect(tool?.execute(toolCall, toolContext)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "extension_result_invalid",
      result: null,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      tool?.execute(toolCall, { ...toolContext, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("enforces the operator output-byte ceiling before result admission", async () => {
    const prepared = prepareExtensions(
      [
        {
          ...registration(
            definition({
              required: [{ kind: "tools.contribute", names: ["search"] }],
            }),
            [toolGrant],
          ),
          maxOutputBytes: 10,
        },
      ],
      undefined,
      [],
    );
    await expect(prepared.tool?.execute(toolCall, toolContext)).resolves.toMatchObject({
      outcome: "error",
      errorCode: "extension_result_invalid",
      result: null,
    });
  });

  it("registers provider adapters only for declared grants and checks revocation per call", async () => {
    const complete = vi.fn(() =>
      Promise.resolve(
        ProviderResultSchema.parse({
          parts: [{ type: "text", text: "synthetic" }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: Code.parse("stop"),
          latencyMs: 1,
        }),
      ),
    );
    const adapter: ProviderAdapter = {
      provider: Code.parse("sample.provider"),
      kind: "openai_compatible",
      complete,
    };
    const prepared = prepareExtensions(
      [
        registration(
          definition({
            required: [
              { kind: "providers.contribute", providers: ["sample.provider"] },
            ],
            createContributions: () => ({ providers: [adapter] }),
          }),
          [providerGrant],
        ),
      ],
      undefined,
      [],
    );
    const provider = prepared.providers[0];
    expect(provider).toBeDefined();
    expect(
      prepared.revokeGrant({
        namespace: "knowledge",
        kind: "providers.contribute",
        target: "sample.provider",
      }),
    ).toBe(true);
    const invokeProvider = async () =>
      provider?.complete(
        {
          requestId: Id.parse("00000000000000000000000003"),
          model: {
            provider: Code.parse("sample.provider"),
            model: Code.parse("sample.model"),
          },
          messages: [],
        },
        {
          signal: new AbortController().signal,
          ids: new SequentialIdGenerator(),
          clock: new FakeClock(1),
        },
      );
    await expect(invokeProvider()).rejects.toMatchObject({ code: "extension_grant_missing" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects duplicate extension identities and undeclared tool contributions", () => {
    const valid = registration(
      definition({ optional: [{ kind: "tools.contribute", names: ["search"] }] }),
      [toolGrant],
    );
    expect(() => prepareExtensions([valid, valid], undefined, [])).toThrow(
      new ExtensionError("extension_contribution_invalid"),
    );
    expect(() =>
      prepareExtensions(
        [
          valid,
          {
            ...valid,
            namespace: "archive",
          },
        ],
        undefined,
        [],
      ),
    ).toThrow(new ExtensionError("extension_contribution_invalid"));

    const undeclared = registration(
      definition({
        optional: [{ kind: "tools.contribute", names: ["other"] }],
        createContributions: () => ({
          tools: [
            defineTool({
              name: "search",
              description: "Not declared.",
              inputSchema,
              outputSchema,
              execute: ({ query }) => Promise.resolve({ answer: query }),
            }),
          ],
        }),
      }),
      [{ kind: "tools.contribute", names: ["other"] }],
    );
    expect(() => prepareExtensions([undeclared], undefined, [])).toThrow(
      new ExtensionError("extension_contribution_invalid"),
    );
  });

  it("rejects missing grants through createHarness without an authoring helper", async () => {
    await expect(
      createHarness({
        config: HarnessConfigSchema.parse({}),
        overrides: {
          store: new InMemoryEventStore(),
          transientVault: true,
          clock: new FakeClock(1),
          ids: new SequentialIdGenerator(),
          model: {
            complete: () => Promise.reject(new Error("not used")),
          },
        },
        extensions: [
          registration(
            definition({
              required: [{ kind: "tools.contribute", names: ["search"] }],
            }),
          ),
        ],
      }),
    ).rejects.toMatchObject({ code: "extension_grant_missing" });
  });

  it("reports and revokes grants through the public harness lifecycle", async () => {
    const harness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store: new InMemoryEventStore(),
        transientVault: true,
        clock: new FakeClock(1),
        ids: new SequentialIdGenerator(),
        model: {
          complete: () => Promise.reject(new Error("not used")),
        },
      },
      extensions: [
        registration(
          definition({
            required: [{ kind: "tools.contribute", names: ["search"] }],
          }),
          [toolGrant],
        ),
      ],
    });

    try {
      expect(harness.getExtensionStatus()[0]?.capabilities[0]).toMatchObject({
        kind: "tools.contribute",
        enabled: ["search"],
        unsupported: [],
      });
      expect(
        harness.revokeExtensionGrant({
          namespace: "knowledge",
          kind: "tools.contribute",
          target: "search",
        }),
      ).toBe(true);
      expect(harness.getExtensionStatus()[0]?.capabilities[0]).toMatchObject({
        enabled: [],
        unsupported: ["search"],
        reason: "not_granted",
      });
    } finally {
      await harness.close();
    }
  });

  it("routes an extension tool through the ordinary core model and policy path", async () => {
    const store = new InMemoryEventStore();
    let invocationSignal: AbortSignal | undefined;
    const execute = vi.fn(
      ({ query }: { readonly query: string }, context: ToolInvocationContext) => {
        invocationSignal = context.signal;
        return Promise.resolve({ answer: query });
      },
    );
    let responseIndex = 0;
    let offeredToolIds: readonly string[] = [];
    const model: ModelPort = {
      complete: (request) => {
        responseIndex += 1;
        if (responseIndex === 1) {
          offeredToolIds = request.tools?.map(({ toolId }) => toolId) ?? [];
          return Promise.resolve({
            parts: [
              {
                type: "tool_call",
                callId: Id.parse("00000000000000000000000004"),
                toolId: Code.parse("knowledge.search"),
                args: { query: "synthetic" },
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: Code.parse("tool_calls"),
            provider: Code.parse("test"),
            model: Code.parse("test-model"),
            latencyMs: 0,
            schemaValid: true,
            repairAttempts: 0,
            fallbackDepth: 0,
            providerBlobs: null,
          });
        }
        return Promise.resolve({
          parts: [{ type: "text", text: "Synthetic answer." }],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: Code.parse("stop"),
          provider: Code.parse("test"),
          model: Code.parse("test-model"),
          latencyMs: 0,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          providerBlobs: null,
        } satisfies ModelCompletion);
      },
    };
    const harness = await createHarness({
      config: HarnessConfigSchema.parse({}),
      overrides: {
        store,
        transientVault: true,
        clock: new FakeClock(1),
        ids: new SequentialIdGenerator(),
        model,
        policy: allowAllPolicy,
      },
      extensions: [
        registration(
          definition({
            required: [{ kind: "tools.contribute", names: ["search"] }],
            createContributions: () => ({
              tools: [
                defineTool({
                  name: "search",
                  description: "Search the synthetic source.",
                  inputSchema,
                  outputSchema,
                  execute,
                }),
              ],
            }),
          }),
          [toolGrant],
        ),
      ],
    });

    try {
      const { runId } = await harness.startRun({ goal: "Use the synthetic search tool." });
      const observedKinds: string[] = [];
      for await (const event of harness.watch(runId, { signal: AbortSignal.timeout(10_000) })) {
        observedKinds.push(event.kind);
        if (event.kind === "run_status" && event.to === "completed") {
          break;
        }
      }
      const events = [];
      for await (const event of store.read(Id.parse(runId))) {
        events.push(event);
      }

      expect(responseIndex).toBe(2);
      expect(offeredToolIds).toContain("knowledge.search");
      expect(execute).toHaveBeenCalledWith({ query: "synthetic" }, expect.anything());
      expect(invocationSignal).toBeInstanceOf(AbortSignal);
      expect(observedKinds).toContain("tool_call");
      expect(events.map(({ type }) => type)).toContain("tool_intent");
      expect(events.map(({ type }) => type)).toContain("tool_result");
    } finally {
      await harness.close();
    }
  });
});
