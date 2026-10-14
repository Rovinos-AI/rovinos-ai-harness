// SPDX-License-Identifier: Apache-2.0
import type { Duplex } from "node:stream";
import { HarnessError } from "@harness/schemas";
import type { SandboxEgressAllowEntrySchema } from "@harness/schemas";
import type { z } from "zod";

/** Bounded outcomes emitted by the egress counter sink. */
export type EgressCounterEvent = "egress_allowed" | "egress_denied";

/** Bounded reasons emitted with egress counters. */
export type EgressReason =
  | "allowed"
  | "invalid_request"
  | "not_allowlisted"
  | "private_address"
  | "resolution_failed"
  | "connect_failed";

/** Bounded startup configuration error codes. */
export type EgressProxyConfigurationErrorCode =
  | "allowlist_missing"
  | "allowlist_empty"
  | "allowlist_invalid"
  | "allowlist_host_invalid"
  | "allowlist_port_invalid"
  | "proxy_port_invalid";

/** Safe startup error for invalid proxy configuration. */
export class EgressProxyConfigurationError extends HarnessError {
  readonly code: EgressProxyConfigurationErrorCode;

  /**
   * Creates a destination-free configuration error.
   *
   * @param code - Bounded failure category.
   */
  constructor(code: EgressProxyConfigurationErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Formats startup configuration errors without including values.
 *
 * @param error - Validated egress proxy configuration error.
 * @returns The closed error code followed by a newline.
 */
export function formatEgressProxyConfigurationError(error: EgressProxyConfigurationError): string {
  return `${error.code}\n`;
}

/** One validated egress destination. */
export type EgressAllowEntry = z.infer<typeof SandboxEgressAllowEntrySchema>;

/** IP resolver used to pin a validated outbound connection to one DNS result. */
export type EgressResolver = (hostname: string) => Promise<readonly string[]>;

/** Socket factory receives only the already-resolved, validated address. */
export type EgressConnector = (address: string, port: number) => Duplex;

/** Host and port pair after request parsing. */
export interface Destination {
  readonly hostname: string;
  readonly port: number;
}

/** Destination pinned to one validated DNS result. */
export interface ResolvedDestination extends Destination {
  readonly address: string;
}
