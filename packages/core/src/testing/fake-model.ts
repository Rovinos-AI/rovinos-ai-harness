// SPDX-License-Identifier: Apache-2.0
import type { ModelCompletion, ModelPort, ModelRequest, RunContext } from "../ports.js";

/** Request and context captured by a fake model call. */
export interface CapturedModelRequest {
  readonly request: ModelRequest;
  readonly context: RunContext;
}

/** Error raised when the fake model script has no completion left. */
export class FakeModelScriptExhaustedError extends Error {
  /** Stable failure code. */
  readonly code = "fake_model_script_exhausted";

  /** Creates a script-exhausted error. */
  constructor() {
    super("The fake model response script is exhausted.");
    this.name = "FakeModelScriptExhaustedError";
  }
}

/** Scripted model implementation that captures requests for assertions. */
export class FakeModelPort implements ModelPort {
  readonly requests: CapturedModelRequest[] = [];
  private nextResponse = 0;

  /**
   * Creates a fake model that returns scripted completions in order.
   *
   * @param script - Completions returned by successive calls.
   */
  constructor(private readonly script: readonly ModelCompletion[]) {}

  /** {@inheritDoc ModelPort.complete} */
  complete(request: ModelRequest, context: RunContext): Promise<ModelCompletion> {
    this.requests.push({ request, context });
    const response = this.script[this.nextResponse];
    this.nextResponse += 1;
    if (response === undefined) {
      return Promise.reject(new FakeModelScriptExhaustedError());
    }
    return Promise.resolve(response);
  }
}
