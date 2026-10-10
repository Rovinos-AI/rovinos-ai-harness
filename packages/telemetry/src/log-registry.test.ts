// SPDX-License-Identifier: Apache-2.0
import { env } from "node:process";
import { beforeEach, describe, expect, it } from "vitest";
import { attr } from "./attr.js";
import {
  __resetLogRegistryForTests,
  defineLogRecord,
  listLogDefinitions,
  lookupLogDefinition,
  LogRegistryError,
} from "./log-registry.js";

describe("log-record registry", () => {
  beforeEach(() => {
    __resetLogRegistryForTests();
  });

  it("registers safe definitions and returns them in registration order", () => {
    const first = defineLogRecord("harness.test.first", {
      "harness.test.code": attr.code(),
      "harness.test.count": attr.nonnegativeInt(),
    });
    const second = defineLogRecord("harness.test.second", {
      "harness.test.enabled": attr.bool(),
    });

    expect(
      first.schema.parse({ "harness.test.code": "safe_code", "harness.test.count": 1 }),
    ).toEqual({ "harness.test.code": "safe_code", "harness.test.count": 1 });
    expect(
      first.schema.safeParse({ "harness.test.code": "safe_code", extra: "value" }).success,
    ).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.shape)).toBe(true);
    expect(listLogDefinitions()).toEqual([first, second]);
    expect(lookupLogDefinition(first.name)).toBe(first);
    expect(lookupLogDefinition("harness.test.missing")).toBeUndefined();
  });

  it("rejects invalid, unsafe, and duplicate definitions", () => {
    for (const name of ["not.harness.name", "Harness.invalid", "harness."]) {
      expect(() => defineLogRecord(name, {})).toThrowError("log_name_invalid");
    }
    expect(() =>
      defineLogRecord("harness.test.invalid_attribute", { private: attr.code() }),
    ).toThrowError("log_attr_name_invalid");
    expect(() =>
      defineLogRecord("harness.test.unsafe", { "harness.test.text": attr.optional(attr.code()) }),
    ).not.toThrow();
    expect(() =>
      defineLogRecord("harness.test.raw", { "harness.test.text": attr.code().transform(String) }),
    ).toThrowError("log_attr_unconstrained");

    defineLogRecord("harness.test.duplicate", {});
    expect(() => defineLogRecord("harness.test.duplicate", {})).toThrowError("log_duplicate");
  });

  it("rejects malformed shapes and protects the test reset outside test mode", () => {
    const malformedShape = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("sensitive shape details");
        },
      },
    );
    expect(() => defineLogRecord("harness.test.malformed", malformedShape)).toThrowError(
      "log_attr_unconstrained",
    );

    const initialNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(() => {
        __resetLogRegistryForTests();
      }).toThrowError("log_registry_reset_forbidden");
    } finally {
      if (initialNodeEnv === undefined) {
        delete env.NODE_ENV;
      } else {
        env.NODE_ENV = initialNodeEnv;
      }
    }
    expect(listLogDefinitions()).toHaveLength(0);
    expect(new LogRegistryError("log_duplicate").code).toBe("log_duplicate");
  });
});
