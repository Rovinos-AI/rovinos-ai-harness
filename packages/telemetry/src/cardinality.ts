// SPDX-License-Identifier: Apache-2.0
import type { Attributes } from "@opentelemetry/api";
import type { Code } from "@rovinos/schemas";
import type { Logger } from "./logger.js";

const DEFAULT_MAX_SERIES = 100;
const DROPPED_TELEMETRY_METRIC = "harness.telemetry.dropped";
const UNBOUNDED_ATTRIBUTE = /(?:^|\.)(?:id|run|session|user|trace|span|path|url)(?:$|\.)/iu;

/** A declared finite or configuration-owned bound for a metric attribute. */
export type MetricAttributeBound =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "config"; readonly source: string };

/** Attribute keys declared for each metric. */
export type MetricAttributeAllowlist = Readonly<Record<string, readonly string[]>>;

/** Bounds declared for each metric's attributes. */
export type MetricAttributeBounds = Readonly<
  Record<string, Readonly<Record<string, MetricAttributeBound>>>
>;

/** Identifies metric labels that are unbounded or missing a declared bound. */
export function metricAttributeBoundViolations(
  allowlist: MetricAttributeAllowlist,
  bounds: MetricAttributeBounds,
): readonly string[] {
  const violations: string[] = [];
  for (const [metric, attributes] of Object.entries(allowlist)) {
    if (!Object.hasOwn(bounds, metric)) {
      violations.push(`${metric}:missing_metric_bounds`);
    }
    for (const attribute of attributes) {
      if (UNBOUNDED_ATTRIBUTE.test(attribute)) {
        violations.push(`${metric}.${attribute}:unbounded_attribute_name`);
      }
      const bound = bounds[metric]?.[attribute];
      if (bound === undefined) {
        violations.push(`${metric}.${attribute}:missing_attribute_bound`);
      } else if (bound.kind === "enum" && bound.values.length > 50) {
        violations.push(`${metric}.${attribute}:enum_too_large`);
      }
    }
  }
  return violations;
}

/** Options for limiting distinct attribute combinations accepted for a metric. */
export interface CardinalityGuardOptions {
  /** Maximum distinct attribute combinations per metric. Defaults to 100. */
  readonly maxSeries?: number;
  /** Counts one rejected metric sample using a bounded reason. */
  readonly onDrop: () => void;
  /** Logs the first overflow for each metric. */
  readonly logger: Pick<Logger, "warn">;
}

function combinationKey(attributes: Attributes): string {
  return JSON.stringify(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Admits a bounded number of distinct metric attribute combinations per metric.
 *
 * @param options Cardinality limit and callbacks for rejected samples.
 */
export class CardinalityGuard {
  readonly #maxSeries: number;
  readonly #onDrop: () => void;
  readonly #logger: Pick<Logger, "warn">;
  readonly #seriesByMetric = new Map<Code, Set<string>>();
  readonly #loggedMetrics = new Set<Code>();

  constructor(options: CardinalityGuardOptions) {
    this.#maxSeries =
      Number.isSafeInteger(options.maxSeries) && (options.maxSeries ?? 0) > 0
        ? options.maxSeries ?? DEFAULT_MAX_SERIES
        : DEFAULT_MAX_SERIES;
    this.#onDrop = options.onDrop;
    this.#logger = options.logger;
  }

  /**
   * Admits an attribute combination unless it would exceed the per-metric limit.
   *
   * @param metric Registered metric name.
   * @param attributes Attribute combination to admit.
   * @returns Whether this combination may be recorded.
   */
  admit(metric: Code, attributes: Attributes): boolean {
    if (metric === DROPPED_TELEMETRY_METRIC) {
      return true;
    }
    const key = combinationKey(attributes);
    let metricSeries = this.#seriesByMetric.get(metric);
    if (metricSeries?.has(key) === true) {
      return true;
    }
    if (metricSeries === undefined) {
      metricSeries = new Set();
      this.#seriesByMetric.set(metric, metricSeries);
    }
    if (metricSeries.size < this.#maxSeries) {
      metricSeries.add(key);
      return true;
    }

    try {
      this.#onDrop();
    } catch {
      // Metric recording must never cause the caller to fail.
    }
    if (!this.#loggedMetrics.has(metric)) {
      this.#loggedMetrics.add(metric);
      try {
        this.#logger.warn("metric_cardinality_exceeded", { "metric.name": metric });
      } catch {
        // Logging must never cause the caller to fail.
      }
    }
    return false;
  }
}
