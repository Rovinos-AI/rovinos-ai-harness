// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Id } from "@harness/schemas";
import type { Token } from "./token.js";
import { z } from "zod";

const vaultValueErrorCodeSchema = z.enum([
  "vault_value_empty",
  "vault_value_too_large",
  "vault_entity_type_invalid",
  "vault_token_space_exhausted",
]);

type VaultValueErrorCode = z.infer<typeof vaultValueErrorCodeSchema>;

const ERROR_MESSAGES: Record<VaultValueErrorCode, string> = {
  vault_value_empty: "Vault value is empty",
  vault_value_too_large: "Vault value is too large",
  vault_entity_type_invalid: "Vault entity type cannot be represented as a token",
  vault_token_space_exhausted: "Vault token space is exhausted",
};

/** Raised when a value cannot be stored, without retaining or exposing it. */
export class VaultValueError extends HarnessError {
  /** Stable error code. */
  readonly code: VaultValueErrorCode;

  /** Create a safe validation error. */
  constructor(code: VaultValueErrorCode) {
    super(ERROR_MESSAGES[vaultValueErrorCodeSchema.parse(code)]);
    this.code = vaultValueErrorCodeSchema.parse(code);
  }
}

/** Creates or reuses a run-scoped token for a sensitive value. */
export interface VaultWriter {
  /**
   * Store a sensitive value and return its run-scoped token.
   * @param runId Run that owns the value.
   * @param entityType Entity type code used in the token.
   * @param raw Original value; normalization is used only for token identity.
   * @returns The stable token for this value within the run and entity type.
   */
  put(runId: Id, entityType: Code, raw: string): Promise<Token>;
}

/** Resolves a run-scoped token to its raw value. */
export interface VaultResolver {
  /**
   * Resolve a token.
   * @param runId Run that owns the token.
   * @param token Token to resolve.
   * @returns The original trimmed value, or undefined when unknown.
   */
  resolve(runId: Id, token: Token): Promise<string | undefined>;
}

/** Reads raw values for leak detection within one run. */
export interface VaultReader {
  /**
   * List raw values owned by a run.
   * @param runId Run to inspect.
   * @returns A detached readonly list of original trimmed values.
   */
  listRawValues(runId: Id): Promise<readonly string[]>;

  /**
   * Return a version that increases when a new entry is added to the run.
   * @param runId Run to inspect.
   * @returns The monotonically increasing run value version.
   */
  version(runId: Id): Promise<number>;
}

/** Performs administrative operations on one run's vault data. */
export interface VaultAdmin {
  /**
   * Remove all entries for a run without resetting its token counters.
   * @param runId Run to purge.
   * @returns The number of removed entries.
   */
  purge(runId: Id): Promise<number>;

  /**
   * Count entries for a run.
   * @param runId Run to inspect.
   * @returns Entry count.
   */
  stats(runId: Id): Promise<{ entries: number }>;
}
