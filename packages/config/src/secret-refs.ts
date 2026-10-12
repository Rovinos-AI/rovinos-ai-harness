// SPDX-License-Identifier: Apache-2.0
import type { SecretRef } from "@harness/schemas";
import type { HarnessConfig } from "./schema.js";

/**
 * Returns secret references from fields declared as `SecretRef` in the config schema.
 *
 * @param config - Validated harness configuration.
 * @returns Schema-owned secret references, excluding arbitrary configuration strings.
 */
export function getConfigSecretRefs(config: HarnessConfig): SecretRef[] {
  return config.models.providers.flatMap((provider) =>
    provider.apiKey === undefined ? [] : [provider.apiKey],
  );
}
