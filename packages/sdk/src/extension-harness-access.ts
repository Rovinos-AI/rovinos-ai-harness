// SPDX-License-Identifier: Apache-2.0
import { ExtensionError, ExtensionGrantRevocationSchema } from "./extensions.js";
import type { ExtensionGrantRevocation, ExtensionRegistrationStatus } from "./extensions.js";

/** Narrow extension-status and revocation callbacks supplied by the harness factory. */
export interface ExtensionHarnessAccessOptions {
  readonly readExtensionStatus: () => readonly ExtensionRegistrationStatus[];
  readonly revokeGrant: (request: ExtensionGrantRevocation) => boolean;
}

/** Provides public extension status and grant-revocation operations. */
export class ExtensionHarnessAccess {
  private readonly readExtensionStatus: ExtensionHarnessAccessOptions["readExtensionStatus"];
  private readonly revokeGrant: ExtensionHarnessAccessOptions["revokeGrant"];

  constructor(options: ExtensionHarnessAccessOptions) {
    this.readExtensionStatus = options.readExtensionStatus;
    this.revokeGrant = options.revokeGrant;
  }

  getExtensionStatus(): readonly ExtensionRegistrationStatus[] {
    return this.readExtensionStatus().map((status) => ({
      ...status,
      capabilities: status.capabilities.map((capability) => ({
        ...capability,
        requested: [...capability.requested],
        enabled: [...capability.enabled],
        unsupported: [...capability.unsupported],
      })),
    }));
  }

  revokeExtensionGrant(request: ExtensionGrantRevocation): boolean {
    const parsedRequest = ExtensionGrantRevocationSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new ExtensionError("extension_grant_invalid");
    }
    return this.revokeGrant(parsedRequest.data);
  }
}
