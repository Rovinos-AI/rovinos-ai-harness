// SPDX-License-Identifier: Apache-2.0
import type { Code, Id } from "@harness/schemas";
import { normalize } from "./normalize.js";
import { Token, tokenTypeName, type Token as TokenValue } from "./token.js";
import {
  VaultValueError,
  type VaultAdmin,
  type VaultReader,
  type VaultResolver,
  type VaultResolveContext,
  type VaultWriter,
} from "./types.js";

const MAX_VALUE_BYTES = 8 * 1024;
const MAX_TOKEN_NUMBER = 999_999;

interface Entry {
  entityType: Code;
  normalizedValue: string;
  rawValue: string;
  token: TokenValue;
}

/** In-memory vault implementation for tests and ephemeral use. */
export class InMemoryVault implements VaultWriter, VaultResolver, VaultReader, VaultAdmin {
  private readonly entries = new Map<Id, Map<TokenValue, Entry>>();
  private readonly counters = new Map<Id, Map<string, number>>();

  /** Store a trimmed value or return the matching token already in the run. */
  put(runId: Id, entityType: Code, raw: string): Promise<TokenValue> {
    const rawValue = raw.trim();

    if (rawValue.length === 0) {
      return Promise.reject(new VaultValueError("vault_value_empty"));
    }
    if (new TextEncoder().encode(rawValue).byteLength > MAX_VALUE_BYTES) {
      return Promise.reject(new VaultValueError("vault_value_too_large"));
    }

    const normalizedValue = normalize(entityType, rawValue);
    const typeName = tokenTypeName(entityType);
    const runEntries = this.entries.get(runId);
    const existing = [...(runEntries?.values() ?? [])].find(
      (entry) => entry.entityType === entityType && entry.normalizedValue === normalizedValue,
    );
    if (existing) {
      return Promise.resolve(existing.token);
    }

    const nextNumber = (this.counters.get(runId)?.get(typeName) ?? 0) + 1;
    if (nextNumber > MAX_TOKEN_NUMBER) {
      return Promise.reject(new VaultValueError("vault_token_space_exhausted"));
    }
    const candidate = `<${typeName}_${String(nextNumber)}>`;
    const token = Token.safeParse(candidate);
    if (!token.success) {
      return Promise.reject(new VaultValueError("vault_entity_type_invalid"));
    }

    const countersForRun = this.counters.get(runId) ?? new Map<string, number>();
    countersForRun.set(typeName, nextNumber);
    this.counters.set(runId, countersForRun);

    const entriesForRun = runEntries ?? new Map<TokenValue, Entry>();
    entriesForRun.set(token.data, { entityType, normalizedValue, rawValue, token: token.data });
    this.entries.set(runId, entriesForRun);
    return Promise.resolve(token.data);
  }

  /** Resolve a token only within its owning run. */
  resolve(
    runId: Id,
    token: TokenValue,
    _context?: VaultResolveContext,
  ): Promise<string | undefined> {
    return Promise.resolve(this.entries.get(runId)?.get(token)?.rawValue);
  }

  /** Return a detached list of values for leak detection. */
  listRawValues(runId: Id): Promise<readonly string[]> {
    return Promise.resolve(
      [...(this.entries.get(runId)?.values() ?? [])].map((entry) => entry.rawValue),
    );
  }

  /** Purge entries but preserve counters so token numbers are never reused. */
  purge(runId: Id): Promise<number> {
    const removed = this.entries.get(runId)?.size ?? 0;
    this.entries.delete(runId);
    return Promise.resolve(removed);
  }

  /** Return the current entry count for a run. */
  stats(runId: Id): Promise<{ entries: number }> {
    return Promise.resolve({ entries: this.entries.get(runId)?.size ?? 0 });
  }
}
