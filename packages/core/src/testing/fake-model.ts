// SPDX-License-Identifier: Apache-2.0
import type { ModelCompletion, ModelPort, ModelRequest, RunContext } from "../ports.js";

/** Request and context captured by a fake model call. */
export interface CapturedModelRequest {
  readonly request: ModelRequest;
  readonly context: RunContext;
}

/** Optional deterministic selector for the scripted response at a conversation position. */
export interface FakeModelOptions {
  readonly responseIndex?: (request: ModelRequest) => number;
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
   * @param script - Completions returned at the selected conversation positions.
   * @param options - Optional selector that derives a position from request history.
   */
  constructor(
    private readonly script: readonly ModelCompletion[],
    private readonly options: FakeModelOptions = {},
  ) {}

  /** {@inheritDoc ModelPort.complete} */
  complete(request: ModelRequest, context: RunContext): Promise<ModelCompletion> {
    this.requests.push({ request, context });
    const selectedIndex = this.options.responseIndex?.(request) ?? this.nextResponse;
    this.nextResponse += 1;
    const response = this.script[selectedIndex];
    if (response === undefined) {
      return Promise.reject(new FakeModelScriptExhaustedError());
    }
    return Promise.resolve(response);
  }
}
