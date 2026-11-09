// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { Sha256Hex, type JsonValue, type Sha256Hex as Sha256HexType } from "@rovinos/schemas";
import type { ExtensionCapability, ExtensionCapabilityStatus } from "./extension-contracts.js";
import { SDK_RANGE_TERM_PATTERN, SDK_VERSION, VERSION_PATTERN } from "./extension-constants.js";

/** Checks a JSON-like object without invoking accessors. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the declared destination identifiers for any capability discriminator. */
export function capabilityTargets(capability: ExtensionCapability): readonly string[] {
  if (capability.kind === "tools.contribute") {
    return capability.names;
  }
  if (capability.kind === "providers.contribute") {
    return capability.providers;
  }
  if (capability.kind === "events.observe") {
    return capability.kinds;
  }
  return capability.bindings;
}

/** Compares parsed three-part semantic versions. */
export function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Parses the supported numeric major.minor.patch representation. */
export function parseVersion(value: string): readonly number[] | undefined {
  if (!VERSION_PATTERN.test(value)) {
    return undefined;
  }
  return value.split(".").map(Number);
}

function isValidOperator(operator: string | undefined): boolean {
  return operator === undefined || ["=", ">", ">=", "<", "<="].includes(operator);
}

/** Validates the bounded conjunction syntax used by extension SDK ranges. */
export function isValidSdkRangeSyntax(range: string): boolean {
  const terms = range.split(" ");
  return (
    terms.length > 0 &&
    terms.every((term) => {
      const match = SDK_RANGE_TERM_PATTERN.exec(term);
      return (
        match !== null &&
        isValidOperator(match[1]) &&
        parseVersion(match[2] ?? "") !== undefined
      );
    })
  );
}

/** Checks whether every constraint in the extension SDK range includes this SDK version. */
export function isSupportedSdkRange(range: string): boolean {
  if (!isValidSdkRangeSyntax(range)) {
    return false;
  }
  const sdkVersion = parseVersion(SDK_VERSION);
  if (sdkVersion === undefined) {
    return false;
  }
  const terms = range.split(" ");
  for (const term of terms) {
    const match = SDK_RANGE_TERM_PATTERN.exec(term);
    const versionText = match?.[2];
    if (match === null || !isValidOperator(match[1]) || versionText === undefined) {
      return false;
    }
    const version = parseVersion(versionText);
    if (version === undefined) {
      return false;
    }
    const comparison = compareVersion(sdkVersion, version);
    const operator = match[1] ?? "=";
    const matches = sdkRangeMatches(operator, comparison);
    if (!matches) {
      return false;
    }
  }
  return true;
}

function sdkRangeMatches(operator: string, comparison: number): boolean {
  switch (operator) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    default:
      return comparison === 0;
  }
}

/** Indicates whether the SDK currently mediates a requested capability kind. */
export function supportsCapability(capability: ExtensionCapability): boolean {
  return capability.kind === "tools.contribute" || capability.kind === "providers.contribute";
}

/** Produces a public, non-sensitive capability support status. */
export function makeCapabilityStatus(
  capability: ExtensionCapability,
  activeTargets: ReadonlySet<string>,
): ExtensionCapabilityStatus {
  const requested = capabilityTargets(capability);
  if (!supportsCapability(capability)) {
    return {
      kind: capability.kind,
      requested: [...requested],
      enabled: [],
      unsupported: [...requested],
      reason: "not_implemented",
    };
  }
  const enabled = requested.filter((target) =>
    activeTargets.has(grantTarget(capability.kind, target)),
  );
  const unsupported = requested.filter(
    (target) => !activeTargets.has(grantTarget(capability.kind, target)),
  );
  const reason = unsupported.length === 0 ? undefined : "not_granted";
  return {
    kind: capability.kind,
    requested: [...requested],
    enabled: [...enabled],
    unsupported: [...unsupported],
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Forms the internal capability/destination grant lookup key. */
export function grantTarget(kind: ExtensionCapability["kind"], target: string): string {
  return `${kind}:${target}`;
}

/** Serializes already-validated JSON with deterministic object-key order. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  if (value === null) {
    return "null";
  }
  return JSON.stringify(value);
}

/** Creates the stable SHA-256 fingerprint used for tool catalogs. */
export function fingerprint(value: string): Sha256HexType {
  return Sha256Hex.parse(createHash("sha256").update(value).digest("hex"));
}
