// SPDX-License-Identifier: Apache-2.0
// Telemetry owns the bounded error base until a shared harness error package exists.
import { Code } from "@harness/schemas";
import type { z } from "zod";

/** Base class for harness errors whose bounded code may be recorded in telemetry. */
export class HarnessError extends Error {
  readonly code: Code;

  /**
   * Creates an error with a validated code and a caller-visible message.
   *
   * @param code - Bounded machine-readable error code.
   * @param message - Human-readable message retained only in process memory.
   */
  constructor(code: string, message = code) {
    super(message);
    const result = Code.safeParse(code);
    if (!result.success) {
      throw new TypeError("Harness error code is invalid.");
    }
    this.name = "HarnessError";
    this.code = result.data;
    Object.defineProperty(this, "code", { configurable: false, writable: false });
  }
}

/** Validation paths returned when span definitions or attributes are invalid. */
export interface SpanRegistryIssue {
  readonly path: readonly (string | number)[];
  readonly code: z.core.$ZodIssue["code"] | "validation_failed";
}

/** Error with a closed code and value-free validation issue details. */
export class SpanRegistryError extends Error {
  readonly code:
    | "span_name_invalid"
    | "span_attr_unconstrained"
    | "span_duplicate"
    | "span_attr_invalid"
    | "span_attr_reserved"
    | "span_registry_reset_forbidden";
  readonly issues: readonly SpanRegistryIssue[];

  /**
   * Creates a registry error without retaining invalid attribute values.
   *
   * @param code - The registry failure code.
   * @param issues - Optional validation paths and Zod issue codes only.
   */
  constructor(code: SpanRegistryError["code"], issues: readonly SpanRegistryIssue[] = []) {
    super(code);
    this.name = "SpanRegistryError";
    this.code = code;
    Object.defineProperty(this, "code", { configurable: false, writable: false });
    this.issues = issues.map(({ path, code: issueCode }) => ({
      path: [...path],
      code: issueCode,
    }));
  }
}
