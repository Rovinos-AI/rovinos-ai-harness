// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ExtensionRegistrationSchema } from "@rovinos/sdk";
import { z } from "zod";
import { createTestRegistration } from "./testing.js";
import { makeTestExtension } from "./testing.test-fixtures.js";

function errorPaths(run: () => unknown): string[] {
  try {
    run();
    return [];
  } catch (error) {
    return error instanceof z.ZodError
      ? error.issues.map(({ path }) => path.join("."))
      : ["unexpected_error"];
  }
}

describe("extension testing helpers", () => {
  it("uses the SDK registration schema and requires explicit grants", () => {
    const definition = makeTestExtension();
    const registration = {
      namespace: "lookup",
      definition,
      grants: [],
    };
    const validated = createTestRegistration(registration);

    expect(definition.createContributions({})).toEqual({});
    expect(ExtensionRegistrationSchema.safeParse(validated).success).toBe(true);
    expect(validated.grants).toEqual([]);
  });

  it("rejects invalid registration identities with the SDK schema's errors", () => {
    const registration = {
      namespace: "invalid namespace",
      definition: makeTestExtension(),
      grants: [],
    };
    const direct = ExtensionRegistrationSchema.safeParse(registration);
    const helperPaths = errorPaths(() => createTestRegistration(registration));

    expect(direct.success).toBe(false);
    expect(helperPaths).toEqual(
      direct.success ? [] : direct.error.issues.map(({ path }) => path.join(".")),
    );
  });
});
