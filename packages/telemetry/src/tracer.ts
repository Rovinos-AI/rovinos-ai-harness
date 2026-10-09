// SPDX-License-Identifier: Apache-2.0
import { trace, type Tracer } from "@opentelemetry/api";

/** Returns the harness tracer used by registered span definitions. */
export function getTracer(): Tracer {
  return trace.getTracer("@harness/telemetry");
}
