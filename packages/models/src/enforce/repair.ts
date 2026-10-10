// SPDX-License-Identifier: Apache-2.0
import type { ModelRequest, Part } from "@harness/schemas";
import type { EnforcementIssue } from "./index.js";

function pathText(path: readonly (string | number)[]): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === "number") {
      return `${result}[${segment}]`;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)) {
      return `${result}.${segment}`;
    }
    return `${result}[${JSON.stringify(segment)}]`;
  }, "$");
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
): ModelRequest {
  const descriptions = issues.map((issue) => `${pathText(issue.path)}: expected ${expectedText(issue)}`);
  return {
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", parts: [...previousOutput] },
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: `Correct the structured output to match the requested schema. Return only the corrected output.\n${descriptions.join("\n")}`,
          },
        ],
      },
    ],
  };
}
