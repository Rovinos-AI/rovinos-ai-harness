// SPDX-License-Identifier: Apache-2.0
import { diag } from "@opentelemetry/api";
import type { KeysConfig } from "@rovinos/schemas";
import { LocalKeyProvider, LocalKeyProviderError } from "@rovinos/vault";
import type { RuntimeOverrides } from "./runtime-config.js";

const keyProviderLogger = diag.createComponentLogger({ namespace: "harness.core" });

/**
 * Creates and eagerly validates the runtime key provider.
 *
 * @param config - Active and historical key references, or undefined for a development key.
 * @param overrides - Secret resolver and safe warning callback.
 * @returns A provider with its current key cached and ready for consumers.
 */
export async function createRuntimeKeys(
  config: KeysConfig | undefined,
  overrides: RuntimeOverrides,
): Promise<LocalKeyProvider> {
  const keys = new LocalKeyProvider({
    ...(config === undefined ? {} : { config }),
    secretResolver: overrides.secretResolver ?? {
      resolve: () => Promise.reject(new LocalKeyProviderError("key_secret_unavailable")),
    },
    onWarning: (code) => {
      keyProviderLogger.warn(code);
      overrides.onKeysWarning?.(code);
    },
  });
  try {
    await keys.getKey(keys.currentKeyId());
    return keys;
  } catch (error) {
    keys.dispose();
    throw error;
  }
}
