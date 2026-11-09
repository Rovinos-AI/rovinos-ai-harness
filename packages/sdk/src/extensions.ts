// SPDX-License-Identifier: Apache-2.0
export {
  ExtensionCapabilitySchema,
  ExtensionCapabilityStatusSchema,
  ExtensionDefinitionSchema,
  ExtensionError,
  ExtensionGrantSchema,
  ExtensionGrantRevocationSchema,
  ExtensionManifestSchema,
  ExtensionRegistrationSchema,
  ExtensionRegistrationStatusSchema,
} from "./extension-contracts.js";
export type {
  ExtensionCapability,
  ExtensionCapabilityStatus,
  ExtensionContributions,
  ExtensionDefinition,
  ExtensionErrorCode,
  ExtensionGrant,
  ExtensionGrantRevocation,
  ExtensionManifest,
  ExtensionRegistration,
  ExtensionRegistrationStatus,
  ExtensionToolDefinition,
  ToolInvocationContext,
} from "./extension-contracts.js";
export { SDK_VERSION } from "./extension-constants.js";
export { defineTool } from "./extension-contracts.js";
export { prepareExtensions } from "./extension-runtime.js";
