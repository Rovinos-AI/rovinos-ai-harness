// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  JsonValue,
  type Code as CodeType,
  type JsonValue as JsonValueType,
  type ToolSpec,
} from "@harness/schemas";
import type {
  ModelToolCall,
  RunContext,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "../ports.js";
import type { RoleRegistry } from "../roles.js";
import { z } from "zod";
import type { SubagentSupervisor } from "./supervisor.js";

/** Strict model input for the built-in `agent.spawn` tool. */
export const AgentSpawnInputSchema = z
  .object({
    role: Code,
    goal: z.string().max(8_000),
    inputs: JsonValue.optional(),
  })
  .strict();

const AGENT_SPAWN_ID: CodeType = "agent.spawn";
const AGENT_SPAWN_SPEC = {
  toolId: AGENT_SPAWN_ID,
  description: "Run an isolated child agent with the selected role.",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string" },
      goal: { type: "string", maxLength: 8_000 },
      inputs: {},
    },
    required: ["role", "goal"],
    additionalProperties: false,
  },
} satisfies ToolSpec;

/** Exposes `agent.spawn` alongside an existing tool registry. */
export class AgentSpawnTool implements ToolPort {
  constructor(
    private readonly inner: ToolPort,
    private readonly roles: RoleRegistry,
    private readonly supervisor: SubagentSupervisor,
  ) {}

  /** Returns a non-idempotent, bounded description for the spawn tool. */
  describe(toolId: CodeType): ToolDescription | undefined {
    if (toolId === AGENT_SPAWN_ID) {
      return { idempotent: false, timeoutMs: 300_000 };
    }
    return this.inner.describe(toolId);
  }

  /** Advertises the spawn schema and all other underlying tools. */
  getToolSpecs(): readonly ToolSpec[] {
    const specs = this.inner.getToolSpecs?.() ?? [];
    return [...specs.filter(({ toolId }) => toolId !== AGENT_SPAWN_ID), AGENT_SPAWN_SPEC];
  }

  /** Leaves spawn inputs tokenized for the child run; delegates other preparation. */
  prepare(call: ModelToolCall, context: RunContext): Promise<ModelToolCall> {
    if (call.toolId === AGENT_SPAWN_ID) {
      return Promise.resolve(call);
    }
    return this.inner.prepare?.(call, context) ?? Promise.resolve(call);
  }

  /** Execute the child run after validating its role and input schema. */
  async execute(call: ModelToolCall, context: RunContext): Promise<ToolExecutionResult> {
    if (call.toolId !== AGENT_SPAWN_ID) {
      return this.inner.execute(call, context);
    }
    const parsed = AgentSpawnInputSchema.safeParse(call.args);
    if (!parsed.success) {
      return { outcome: "error", errorCode: "agent_spawn_invalid", result: null };
    }
    const role = this.roles.resolveRole(parsed.data.role);
    const result = await this.supervisor.spawn({
      role,
      goal: parsed.data.goal,
      ...(parsed.data.inputs === undefined ? {} : { inputs: parsed.data.inputs }),
      call,
      context,
    });
    const value: JsonValueType = JsonValue.parse(result);
    return { outcome: "ok", result: value };
  }
}
