// SPDX-License-Identifier: Apache-2.0
import type { Code, ToolSpec } from "@harness/schemas";
import type { ToolPort } from "./ports.js";

/** Routes a built-in tool alongside an existing runtime tool port. */
export function composeToolPorts(additional: ToolPort, existing: ToolPort): ToolPort {
  const ports = [additional, existing];
  const portFor = (toolId: Code): ToolPort =>
    ports.find((port) => port.describe(toolId) !== undefined) ?? existing;
  const getToolSpecs = () => {
    const specs = new Map<Code, ToolSpec>();
    for (const port of ports) {
      for (const spec of port.getToolSpecs?.() ?? []) {
        if (!specs.has(spec.toolId)) {
          specs.set(spec.toolId, spec);
        }
      }
    }
    return [...specs.values()];
  };
  const prepare = ports.some((port) => port.prepare !== undefined)
    ? (
        call: Parameters<NonNullable<ToolPort["prepare"]>>[0],
        context: Parameters<NonNullable<ToolPort["prepare"]>>[1],
      ) => portFor(call.toolId).prepare?.(call, context) ?? Promise.resolve(call)
    : undefined;
  const validateInputSchema = ports.some((port) => port.validateInputSchema !== undefined)
    ? (
        toolId: Code,
        args: Parameters<NonNullable<ToolPort["validateInputSchema"]>>[1],
        schema: Parameters<NonNullable<ToolPort["validateInputSchema"]>>[2],
        context: Parameters<NonNullable<ToolPort["validateInputSchema"]>>[3],
      ) =>
        portFor(toolId).validateInputSchema?.(toolId, args, schema, context) ??
        Promise.resolve(true)
    : undefined;
  return {
    ...(prepare === undefined ? {} : { prepare }),
    ...(validateInputSchema === undefined ? {} : { validateInputSchema }),
    describe: (toolId) => portFor(toolId).describe(toolId),
    getToolSpecs,
    execute: (call, context) => portFor(call.toolId).execute(call, context),
  };
}
