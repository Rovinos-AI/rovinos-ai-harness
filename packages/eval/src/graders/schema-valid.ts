// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import { extractJson } from "@rovinos/models";
import { validateWithTokens } from "@rovinos/pii";
import { z } from "zod";
import type { GraderSpec } from "../schema.js";
import type { Grader, GradeContext } from "./types.js";
import { makeGradeResult } from "./types.js";
type SchemaValidSpec = Extract<GraderSpec, { type: "schema_valid" }>;

function textFromFinalResponse(ctx: GradeContext): string | undefined {
  const textParts = ctx.events
    ?.filter((event) => event.type === "model_response")
    .sort((left, right) => left.seq - right.seq)
    .flatMap((event) => event.content)
    .filter((part) => part.type === "text");
  return textParts?.at(-1)?.text;
}

async function loadSchema(schemaRef: string): Promise<z.ZodType | undefined> {
  const separator = schemaRef.lastIndexOf("#");
  if (separator <= 0 || separator === schemaRef.length - 1) {
    return undefined;
  }
  const modulePath = schemaRef.slice(0, separator);
  const exportName = schemaRef.slice(separator + 1);
  try {
    const loaded: unknown = await import(pathToFileURL(modulePath).href);
    if (typeof loaded !== "object" || loaded === null || !Object.hasOwn(loaded, exportName)) {
      return undefined;
    }
    const schema: unknown = Reflect.get(loaded, exportName);
    return schema instanceof z.ZodType ? schema : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a grader validating the final model response against an exported Zod schema.
 *
 * @param schemaRef - Absolute module path and exported schema name, separated by `#`.
 */
export function createSchemaValidGrader(spec: SchemaValidSpec): Grader {
  return {
    id: "schema_valid",
    async grade(ctx: GradeContext) {
      const text = textFromFinalResponse(ctx);
      if (text === undefined) {
        return makeGradeResult("schema_valid", false, "no_json");
      }
      const extracted = extractJson(text);
      if (!extracted.ok) {
        return makeGradeResult("schema_valid", false, "no_json");
      }
      const schema = await loadSchema(spec.schemaRef);
      if (schema === undefined) {
        return makeGradeResult("schema_valid", false, "schema_invalid");
      }
      try {
        if (ctx.tokenValidation !== undefined) {
          if (ctx.result.runId === undefined) {
            return makeGradeResult("schema_valid", false, "schema_invalid");
          }
          const validation = await validateWithTokens(schema, extracted.value, {
            ...ctx.tokenValidation,
            runId: ctx.result.runId,
          });
          return makeGradeResult(
            "schema_valid",
            validation.ok,
            validation.ok ? undefined : "schema_invalid",
          );
        }
        const validation = await schema.safeParseAsync(extracted.value);
        return makeGradeResult(
          "schema_valid",
          validation.success,
          validation.success ? undefined : "schema_invalid",
        );
      } catch {
        return makeGradeResult("schema_valid", false, "schema_invalid");
      }
    },
  };
}
