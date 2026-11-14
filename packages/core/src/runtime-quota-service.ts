// SPDX-License-Identifier: Apache-2.0
import type { EventStore } from "@rovinos/store";
import type { Clock } from "./recorder.js";
import { QuotaService, strictSpendPricingFromConfig } from "./quotas.js";
import type { RuntimeConfig } from "./runtime-config.js";

/** Build the quota service from the validated runtime configuration. */
export function createRuntimeQuotaService(
  config: RuntimeConfig,
  store: EventStore,
  clock: Clock,
): QuotaService {
  const strictPricing = strictSpendPricingFromConfig(config);
  return new QuotaService(config.quotas ?? [], store, clock, strictPricing);
}
