// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type ModelRequest } from "@rovinos/schemas";
import type { ProviderAdapter, ProviderContext, ProviderResult } from "../types.js";

/** Raised when a scripted fake provider has no result left to replay. */
export class FakeProviderScriptExhaustedError extends HarnessError {
  /** Stable fake-provider failure code. */
  readonly code = "fake_provider_script_exhausted";

  /** Creates a script-exhausted error. */
  constructor() {
    super("The fake provider result script is exhausted.");
  }
}

/** Scripted provider adapter that captures normalized requests. */
export class FakeProvider implements ProviderAdapter {
  readonly requests: ModelRequest[] = [];
  readonly kind: "anthropic" | "openai";
  private nextResult = 0;

  /**
   * @param provider - Provider code exposed by this fake adapter.
   * @param script - Results replayed in order for successive calls.
   */
  constructor(
    readonly provider: Code,
    private readonly script: readonly ProviderResult[],
  ) {
    this.kind = provider === "anthropic" ? "anthropic" : "openai";
  }

  /** {@inheritDoc ProviderAdapter.complete} */
  complete(request: ModelRequest, _context: ProviderContext): Promise<ProviderResult> {
    this.requests.push(request);
    const result = this.script[this.nextResult];
    this.nextResult += 1;
    if (result === undefined) {
      return Promise.reject(new FakeProviderScriptExhaustedError());
    }
    return Promise.resolve(result);
  }
}
