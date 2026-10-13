// SPDX-License-Identifier: Apache-2.0
import type { PiiConfig } from "@harness/schemas";
import {
  creditCardDetector,
  createCustomDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  Tokenizer,
  urlCredentialsDetector,
  type Detector,
} from "@harness/pii";
import { AuditingVaultResolver, type VaultResolver, type VaultWriter } from "@harness/vault";
import type { RunScopeRegistry } from "./subagent/scope.js";

const builtInDetectors: readonly Detector[] = [
  creditCardDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  urlCredentialsDetector,
];

/** Builds the PII dependencies shared by the runtime's tool and storage boundaries. */
export function createRuntimePii(
  config: PiiConfig,
  vault: VaultWriter & VaultResolver,
  scopes: RunScopeRegistry,
): { readonly tokenizer: Tokenizer; readonly resolver: AuditingVaultResolver } {
  const detectors = [
    ...builtInDetectors,
    ...(config.custom ?? []).map((detector) => createCustomDetector(detector)),
  ];
  const tokenizer = new Tokenizer({
    detectors: {
      detect: (text) => detectors.flatMap((detector) => detector.detect(text)),
    },
    policy: config,
    vault,
    scopeOf: scopes.scopeOf,
  });
  const resolver = new AuditingVaultResolver(vault, () => undefined, scopes.scopeOf);
  return { tokenizer, resolver };
}
