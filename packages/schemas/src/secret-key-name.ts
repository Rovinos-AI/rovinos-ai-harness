// SPDX-License-Identifier: Apache-2.0
/** Returns whether a configuration key name matches the inline-secret pattern. */
export function isSecretKeyName(name: string): boolean {
  return /api[-_]?key|token|password|secret|credential/iu.test(name);
}
