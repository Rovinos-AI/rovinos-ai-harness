// SPDX-License-Identifier: Apache-2.0
import { ExtensionDefinitionSchema } from "@rovinos/sdk";
import type { ExtensionDefinition, ExtensionRegistration } from "@rovinos/sdk";

/** Validate an extension definition with the SDK's canonical contract and preserve its config type. */
export function defineExtension<ConfigSchema extends ExtensionDefinition["configSchema"]>(
  definition: ExtensionDefinition<ConfigSchema>,
): ExtensionDefinition<ConfigSchema> {
  ExtensionDefinitionSchema.parse(definition);
  return definition;
}

/** Combine registration groups without changing their operator-supplied grants. */
export function composeExtensions(
  ...groups: readonly (readonly ExtensionRegistration[])[]
): readonly ExtensionRegistration[] {
  return groups.flatMap((group) => group);
}
