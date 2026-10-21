// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@harness/schemas";
import type { z } from "zod";

/** Closed SDK startup failure. */
export class TelemetrySdkError extends HarnessError {
  readonly code = "telemetry_content_capture_enabled";

  constructor() {
    super("telemetry_content_capture_enabled");
    Object.defineProperty(this, "code", { configurable: false, writable: false });
  }
}

/** Validation paths returned when span definitions or attributes are invalid. */
export interface SpanRegistryIssue {
  readonly path: readonly (string | number)[];
  readonly code: z.core.$ZodIssue["code"] | "validation_failed";
}

/** Error with a closed code and value-free validation issue details. */
export class SpanRegistryError extends HarnessError {
  readonly code:
    | "span_name_invalid"
    | "span_attr_name_invalid"
    | "span_attr_unconstrained"
    | "span_duplicate"
    | "span_attr_invalid"
    | "span_attr_reserved"
    | "span_owner_task_invalid"
    | "span_registry_reset_forbidden"
    | "span_unsafe_test_registration_forbidden";
  readonly issues: readonly SpanRegistryIssue[];

  /**
   * Creates a registry error without retaining invalid attribute values.
   *
   * @param code - The registry failure code.
   * @param issues - Optional validation paths and Zod issue codes only.
   */
  constructor(code: SpanRegistryError["code"], issues: readonly SpanRegistryIssue[] = []) {
    super(code);
    this.code = code;
    Object.defineProperty(this, "code", { configurable: false, writable: false });
    this.issues = issues.map(({ path, code: issueCode }) => ({
      path: [...path],
      code: issueCode,
    }));
  }
}
