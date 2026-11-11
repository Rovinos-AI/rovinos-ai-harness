// SPDX-License-Identifier: Apache-2.0
import { CardinalityGuard } from "./cardinality.js";
import { createLogger } from "./logger.js";

const metricCardinalityLogger = createLogger({ level: "warn" });

/** Creates the guarded metric-series limiter with the shared warning logger. */
export function createMetricCardinalityGuard(
  maxSeries: number,
  onDrop: () => void,
): CardinalityGuard {
  return new CardinalityGuard({ maxSeries, onDrop, logger: metricCardinalityLogger });
}
