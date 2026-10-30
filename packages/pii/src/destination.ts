// SPDX-License-Identifier: Apache-2.0
import { HarnessError } from "@rovinos/schemas";
import type { Code, Destination, PiiBoundary } from "@rovinos/schemas";

/** Provider trust used to select the model-input destination. */
export interface ProviderTrust {
  readonly trust?: "hosted" | "local";
}

/** Boundary metadata used to resolve one PII destination. */
export interface ResolveDestinationOptions {
  readonly boundary: PiiBoundary;
  readonly provider?: ProviderTrust;
  readonly toolId?: Code;
}

/** Raised when a tool boundary cannot be associated with a specific tool. */
export class PiiDestinationError extends HarnessError {
  readonly code = "pii_destination_missing";

  constructor() {
    super("A tool destination requires a tool identifier.");
  }
}

/**
 * Resolves the destination associated with a PII boundary.
 *
 * Missing provider trust defaults to hosted, which avoids assuming a local
 * provider can receive raw values. Tool boundaries require an explicit ID.
 *
 * @param options - Boundary and optional provider or tool metadata.
 * @returns The trust destination used for policy evaluation.
 */
export function resolveDestination({
  boundary,
  provider,
  toolId,
}: ResolveDestinationOptions): Destination {
  switch (boundary) {
    case "model_input":
      return provider?.trust ?? "hosted";
    case "tool_input":
    case "tool_output":
      if (toolId === undefined) {
        throw new PiiDestinationError();
      }
      return { tool: toolId };
    case "storage":
    case "ui":
      return "any";
  }
}
