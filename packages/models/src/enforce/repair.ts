// SPDX-License-Identifier: Apache-2.0
import type { JsonValue, ModelRequest, Part } from "@harness/schemas";
import type { EnforcementIssue, EnforcementRung } from "./index.js";

function schemaObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function schemaChildren(schema: JsonValue | undefined, key: string): JsonValue[] {
  const object = schemaObject(schema);
  const children: JsonValue[] = [];
  const direct = object?.[key];
  if (direct !== undefined) {
    children.push(direct);
  }
  for (const branch of ["anyOf", "oneOf", "allOf"]) {
    const alternatives = object?.[branch];
    if (Array.isArray(alternatives)) {
      for (const alternative of alternatives) {
        children.push(...schemaChildren(alternative, key));
      }
    }
  }
  return children;
}

/** Replaces path segments not declared by the schema with a value-free wildcard. */
export function redactIssuePath(
  path: readonly (string | number)[],
  schema: JsonValue | undefined,
): (string | number)[] {
  let schemas = schema === undefined ? [] : [schema];
  return path.map((segment) => {
    if (typeof segment === "number") {
      schemas = schemas.flatMap((candidate) => {
        const prefixItems = schemaChildren(candidate, "prefixItems").flatMap((value) =>
          Array.isArray(value) ? [value] : [],
        );
        return [
          ...prefixItems.flatMap((items) => (items[segment] === undefined ? [] : [items[segment]])),
          ...schemaChildren(candidate, "items"),
        ];
      });
      return segment;
    }

    const propertySchemas = schemas.flatMap((candidate) =>
      schemaChildren(candidate, "properties").flatMap((value) => {
        const properties = schemaObject(value);
        if (properties === undefined || !Object.hasOwn(properties, segment)) {
          return [];
        }
        const propertySchema = properties[segment];
        return propertySchema === undefined ? [] : [propertySchema];
      }),
    );
    if (propertySchemas.length > 0) {
      schemas = propertySchemas;
      return segment;
    }

    schemas = schemas.flatMap((candidate) =>
      schemaChildren(candidate, "additionalProperties").filter(
        (additional) => typeof additional === "object" && additional !== null,
      ),
    );
    return "*";
  });
}

function pathText(path: readonly (string | number)[], schema: JsonValue | undefined): string {
  return redactIssuePath(path, schema).reduce<string>((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${String(segment)}]`;
    }
    if (segment === "*") {
      return `${result}[*]`;
    }
    return /^[\w$]+$/u.test(segment)
      ? `${result}.${segment}`
      : `${result}[${JSON.stringify(segment)}]`;
  }, "$");
}

function issueDescriptions(
  issues: readonly EnforcementIssue[],
  schema: JsonValue | undefined,
): string[] {
  return issues.map((issue) => `${pathText(issue.path, schema)}: expected ${expectedText(issue)}`);
}

function repairMessages(
  previousOutput: readonly Part[],
  rung: EnforcementRung | undefined,
  descriptions: readonly string[],
): ModelRequest["messages"] {
  const assistantParts =
    rung === "tool" ? previousOutput.filter((part) => part.type !== "opaque") : [...previousOutput];
  const messages: ModelRequest["messages"] =
    rung === "tool" && assistantParts.length === 0
      ? []
      : [{ role: "assistant", parts: assistantParts }];
  const toolCalls = assistantParts.filter((part) => part.type === "tool_call");
  if (rung === "tool" && toolCalls.length > 0) {
    messages.push({
      role: "tool",
      parts: toolCalls.map((part) => ({
        type: "tool_result" as const,
        callId: part.callId,
        result: descriptions.join("\n"),
        isError: true,
      })),
    });
    return messages;
  }

  messages.push({
    role: "user",
    parts: [
      {
        type: "text",
        text: `Correct the structured output to match the requested schema. Return only the corrected output.\n${descriptions.join("\n")}`,
      },
    ],
  });
  return messages;
}

function expectedText(issue: EnforcementIssue): string {
  if (issue.expected !== undefined) {
    return issue.expected;
  }
  if (issue.code === "invalid_json") {
    return "valid JSON";
  }
  if (issue.code === "too_small") {
    return "a value meeting the minimum constraint";
  }
  if (issue.code === "too_big") {
    return "a value meeting the maximum constraint";
  }
  return "a value matching the requested schema";
}

/** Builds a repair request using only the previous assistant output and value-free issue metadata. */
export function appendRepairMessages(
  request: ModelRequest,
  previousOutput: readonly Part[],
  issues: readonly EnforcementIssue[],
  rung?: EnforcementRung,
): ModelRequest {
  const descriptions = issueDescriptions(issues, request.output?.schema);
  return {
    ...request,
    messages: [...request.messages, ...repairMessages(previousOutput, rung, descriptions)],
  };
}
