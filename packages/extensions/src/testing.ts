// SPDX-License-Identifier: Apache-2.0
import { ExtensionRegistrationSchema } from "@rovinos/sdk";
import type { ExtensionRegistration } from "@rovinos/sdk";

/** Validate a test registration with the SDK schema; grants must be supplied explicitly. */
export function createTestRegistration(registration: ExtensionRegistration): ExtensionRegistration {
  return ExtensionRegistrationSchema.parse(registration);
}
