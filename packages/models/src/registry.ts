// SPDX-License-Identifier: Apache-2.0
import type { Code } from "@harness/schemas";
import { ProviderNotRegisteredError } from "./errors.js";
import type { ProviderAdapter } from "./types.js";

/** Maps provider codes to the adapters that implement them. */
export class AdapterRegistry {
  private readonly adapters: ReadonlyMap<Code, ProviderAdapter>;

  /**
   * @param adapters - Adapters available to the gateway.
   */
  constructor(adapters: readonly ProviderAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  /**
   * Returns the adapter registered for a provider.
   *
   * @param provider - Provider code from a normalized model request.
   * @returns The matching provider adapter.
   * @throws ProviderNotRegisteredError when the provider is unknown.
   */
  get(provider: Code): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) {
      throw new ProviderNotRegisteredError(provider);
    }
    return adapter;
  }
}
