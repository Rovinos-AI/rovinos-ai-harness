// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  HarnessError,
  PII_BUILTIN_ENTITIES,
  PiiBoundarySchema,
  PiiEntitySchema,
  PiiExplainResultSchema,
  type Destination,
  type PiiBoundary,
  type PiiConfig,
  type PiiEntity,
} from "@rovinos/schemas";
import { resolveDestination, resolvePiiPolicyAction } from "@rovinos/pii";
import { z } from "zod";
import type { CliContext, CommandModule } from "../command.js";

const ExplainOptionsSchema = z
  .object({
    boundary: PiiBoundarySchema.optional(),
    destination: z.string().optional(),
    entity: PiiEntitySchema.optional(),
    matrix: z.boolean().default(false),
  })
  .strict();

class PiiExplainUsageError extends HarnessError {
  readonly code = "usage";

  constructor() {
    super("Invalid PII explain options.");
  }
}

function parseDestinationOption(value: string): Destination {
  if (value === "hosted" || value === "local") {
    return value;
  }
  if (value.startsWith("tool:")) {
    const toolId = Code.safeParse(value.slice("tool:".length));
    if (toolId.success) {
      return { tool: toolId.data };
    }
  }
  throw new PiiExplainUsageError();
}

function resolveRequestedDestination(boundary: PiiBoundary, requested: Destination): Destination {
  const isToolBoundary = boundary === "tool_input" || boundary === "tool_output";
  if (isToolBoundary !== (typeof requested === "object")) {
    if (boundary === "storage" || boundary === "ui") {
      return resolveDestination({ boundary });
    }
    throw new PiiExplainUsageError();
  }
  if (typeof requested === "string") {
    if (requested !== "hosted" && requested !== "local") {
      throw new PiiExplainUsageError();
    }
    return resolveDestination({ boundary, provider: { trust: requested } });
  }
  return resolveDestination({
    boundary,
    toolId: requested.tool,
  });
}

function configuredToolIds(config: PiiConfig): Code[] {
  const ids = new Set<Code>();
  for (const rule of config.rules) {
    if (rule.destinations !== "*") {
      for (const destination of rule.destinations) {
        if (typeof destination === "object") {
          ids.add(destination.tool);
        }
      }
    }
  }
  for (const rule of config.detokenize ?? []) {
    const toolId = Code.safeParse(rule.toolId);
    if (toolId.success) {
      ids.add(toolId.data);
    }
  }
  return [...ids].sort();
}

function entitiesForConfig(custom: readonly { readonly name: string }[]): PiiEntity[] {
  return [
    ...PII_BUILTIN_ENTITIES,
    ...custom.map(({ name }) => PiiEntitySchema.parse(`custom_${name}`)),
  ];
}

function matrixDestinations(
  boundary: PiiBoundary,
  toolIds: readonly Code[],
): readonly Destination[] {
  if (boundary === "model_input") {
    return ["hosted", "local"];
  }
  if (boundary === "tool_input" || boundary === "tool_output") {
    return toolIds.map((tool) => ({ tool }));
  }
  return ["any"];
}

function explainRow(
  config: Awaited<ReturnType<CliContext["loadConfig"]>>["pii"],
  boundary: PiiBoundary,
  destination: Destination,
  entity: PiiEntity,
) {
  const resolved = resolvePiiPolicyAction(
    config,
    { boundary, destination, entity },
    config.allowRawToLocalModels,
  );
  return {
    boundary,
    destination,
    entity,
    action: resolved.action,
    ruleIndex: resolved.ruleIndex,
  };
}

async function runExplain(rawOptions: unknown, context: CliContext): Promise<void> {
  const options = ExplainOptionsSchema.safeParse(rawOptions);
  if (!options.success) {
    throw new PiiExplainUsageError();
  }
  if (
    options.data.matrix
      ? options.data.boundary !== undefined ||
        options.data.destination !== undefined ||
        options.data.entity !== undefined
      : options.data.boundary === undefined ||
        options.data.destination === undefined ||
        options.data.entity === undefined
  ) {
    throw new PiiExplainUsageError();
  }

  const config = (await context.loadConfig()).pii;
  let result: z.infer<typeof PiiExplainResultSchema>;
  if (options.data.matrix) {
    const toolIds = configuredToolIds(config);
    result = {
      mode: "matrix",
      results: PiiBoundarySchema.options.flatMap((boundary) =>
        matrixDestinations(boundary, toolIds).flatMap((destination) =>
          entitiesForConfig(config.custom ?? []).map((entity) =>
            explainRow(config, boundary, destination, entity),
          ),
        ),
      ),
    };
  } else {
    const boundary = options.data.boundary;
    const entity = options.data.entity;
    const destinationOption = options.data.destination;
    if (boundary === undefined || entity === undefined || destinationOption === undefined) {
      throw new PiiExplainUsageError();
    }
    const requested = parseDestinationOption(destinationOption);
    result = {
      mode: "explain",
      result: explainRow(
        config,
        boundary,
        resolveRequestedDestination(boundary, requested),
        entity,
      ),
    };
  }

  context.out.json(PiiExplainResultSchema, result);
  if (result.mode === "matrix") {
    context.out.table([
      ["boundary", "destination", "entity", "action", "rule"],
      ...result.results.map(({ boundary, destination, entity, action, ruleIndex }) => [
        boundary,
        typeof destination === "string" ? destination : `tool:${destination.tool}`,
        entity,
        action,
        ruleIndex,
      ]),
    ]);
  } else {
    const { boundary, destination, entity, action, ruleIndex } = result.result;
    context.out.table([
      ["boundary", "destination", "entity", "action", "rule"],
      [
        boundary,
        typeof destination === "string" ? destination : `tool:${destination.tool}`,
        entity,
        action,
        ruleIndex,
      ],
    ]);
  }
}

/** Registers the PII policy explanation command. */
export const piiCommand: CommandModule = {
  name: "pii",
  /** Registers `harness pii explain`. */
  register(program, context) {
    program
      .command("pii")
      .description("Explain PII policy decisions")
      .command("explain")
      .description("Explain one PII decision or print the configured policy matrix")
      .option("--boundary <boundary>", "PII boundary")
      .option("--destination <destination>", "hosted, local, or tool:<id>")
      .option("--entity <entity>", "PII entity type")
      .option("--matrix", "print the full configured policy matrix")
      .action(async (rawOptions: unknown) => runExplain(rawOptions, context));
  },
};
