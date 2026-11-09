// SPDX-License-Identifier: Apache-2.0
import type { ToolPort } from "@rovinos/core";
import type { ProviderAdapter } from "@rovinos/models";
import type { ExtensionGrantRevocation, ExtensionRegistrationStatus } from "./extension-contracts.js";

/** Validated extension ports and lifecycle operations for the SDK runtime. */
export interface PreparedExtensions {
  readonly tool?: ToolPort;
  readonly providers: readonly ProviderAdapter[];
  getStatuses(): readonly ExtensionRegistrationStatus[];
  revokeGrant(request: ExtensionGrantRevocation): boolean;
}
