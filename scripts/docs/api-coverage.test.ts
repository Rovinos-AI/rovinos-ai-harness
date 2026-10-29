// SPDX-License-Identifier: Apache-2.0
import { parseJson } from "@rovinos/schemas";
import { describe, expect, it } from "vitest";
import {
  calculateApiCoverage,
  TypeDocReflectionSchema,
  type TypeDocReflection,
} from "./api-coverage.js";

const fixtureJson = JSON.stringify({
  id: 0,
  name: "Documentation",
  kind: 1,
  children: [
    {
      id: 1,
      name: "@fixture/api",
      kind: 2,
      children: [
        {
          id: 2,
          name: "documentedFunction",
          kind: 64,
          comment: { summary: [{ kind: "text", text: "A documented function." }] },
        },
        { id: 3, name: "UndocumentedClass", kind: 128 },
        {
          id: 4,
          name: "DocumentedInterface",
          kind: 256,
          comment: { summary: [{ kind: "text", text: "A documented interface." }] },
        },
        {
          id: 5,
          name: "DocumentedAlias",
          kind: 2_097_152,
          comment: { summary: [{ kind: "text", text: "A documented type alias." }] },
        },
        {
          id: 6,
          name: "InternalAlias",
          kind: 2_097_152,
          comment: { blockTags: [{ tag: "@internal", content: [] }] },
        },
        {
          id: 7,
          name: "method",
          kind: 2048,
          comment: { summary: [{ kind: "text", text: "Not counted as an export." }] },
        },
      ],
    },
    {
      id: 8,
      name: "@rovinos/store",
      kind: 2,
      children: [{ id: 9, name: "PrivateHelper", kind: 64 }],
    },
  ],
});

describe("calculateApiCoverage", () => {
  it("counts documented API declarations, lists missing descriptions, and ignores @internal", () => {
    const project = parseJson(TypeDocReflectionSchema, fixtureJson);

    expect(calculateApiCoverage(project, ["@fixture/api"])).toEqual({
      documented: 3,
      total: 4,
      percent: 75,
      undocumented: ["Documentation.@fixture/api.UndocumentedClass"],
    });
  });

  it("returns zero coverage when the TypeDoc project contains no eligible exports", () => {
    const project: TypeDocReflection = {
      kind: 1,
      children: [{ kind: 2, children: [{ kind: 2048 }] }],
    };

    expect(calculateApiCoverage(project, ["@fixture/api"])).toEqual({
      documented: 0,
      total: 0,
      percent: 0,
      undocumented: [],
    });
  });
});
