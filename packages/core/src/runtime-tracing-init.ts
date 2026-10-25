// SPDX-License-Identifier: Apache-2.0
import { ensureTracingFallback } from "@rovinos/telemetry";
import { RUN_SPAN } from "./spans.js";
import { SystemIdGenerator, systemClock } from "./runtime-ids.js";

/** Installs the process fallback only when no tracing provider exists. */
export function ensureTracing(): void {
  const probeIds = new SystemIdGenerator(systemClock);
  const probe = RUN_SPAN.start({
    "harness.run.id": probeIds.next(),
    "harness.segment.id": probeIds.next(),
  });
  ensureTracingFallback(probe);
}
