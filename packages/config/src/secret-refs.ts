// SPDX-License-Identifier: Apache-2.0
import { SecretRefSchema, type SecretRef } from "@harness/schemas";
import type { HarnessConfig } from "./schema.js";

function parseSecretRefs(values: readonly string[]): SecretRef[] {
  return values.flatMap((value) => {
    const parsed = SecretRefSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Returns secret references from fields declared as `SecretRef` in the config schema.
 *
 * @param config - Validated harness configuration.
 * @returns Schema-owned secret references, excluding arbitrary configuration strings.
 */
export function getConfigSecretRefs(config: HarnessConfig): SecretRef[] {
  const modelRefs = config.models.providers.flatMap((provider) =>
    provider.apiKey === undefined ? [] : [provider.apiKey],
  );
  const serverRefs = config.servers.flatMap(({ transport }) =>
    transport.kind === "stdio"
      ? parseSecretRefs(Object.values(transport.env ?? {}))
      : parseSecretRefs(Object.values(transport.headers ?? {})),
  );
  return [...modelRefs, ...serverRefs];
}
