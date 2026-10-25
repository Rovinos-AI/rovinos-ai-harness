// SPDX-License-Identifier: Apache-2.0
import type { Code, InputRequest, InputResponse } from "@rovinos/schemas";

/** A registered channel that can present a recorded input request to a human. */
export interface HumanInputChannel {
  /** Stable code identifying this channel. */
  readonly id: Code;
  /** Whether this channel can present the given request. */
  available(req: InputRequest): boolean;
  /** Present a request and return the human's response and principal. */
  present(req: InputRequest, signal: AbortSignal): Promise<InputResponse & { principal: Code }>;
}
