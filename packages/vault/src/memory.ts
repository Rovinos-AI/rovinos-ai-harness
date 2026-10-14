// SPDX-License-Identifier: Apache-2.0
import type { Code, Id } from "@harness/schemas";
import { normalize } from "./normalize.js";
import { Token, tokenTypeName, type Token as TokenValue } from "./token.js";
import {
  VaultValueError,
  VaultTerminalRunsQuerySchema,
  VaultTimestampSchema,
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
  private readonly purgeEpochs = new Map<Id, number>();
  private readonly terminalRuns = new Map<Id, number>();

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
    _context: VaultResolveContext,
  ): Promise<string | undefined> {
    return Promise.resolve(this.entries.get(runId)?.get(token)?.rawValue);
  }

  /** Return a detached list of values for leak detection. */
  listRawValues(runId: Id): Promise<readonly string[]> {
    return Promise.resolve(
      [...(this.entries.get(runId)?.values() ?? [])].map((entry) => entry.rawValue),
    );
  }

  /** Return a monotonic version for entries ever added to or purged from a run. */
  version(runId: Id): Promise<number> {
    const counters = this.counters.get(runId);
    let version = this.purgeEpochs.get(runId) ?? 0;
    for (const nextNumber of counters?.values() ?? []) {
      version += nextNumber;
    }
    return Promise.resolve(version);
  }

  /** Record when a run entered a terminal state for grace-period retention. */
  markTerminal(runId: Id, ts: number): Promise<void> {
    const timestamp = VaultTimestampSchema.parse(ts);
    this.terminalRuns.set(runId, Math.min(this.terminalRuns.get(runId) ?? timestamp, timestamp));
    return Promise.resolve();
  }

  /** Find a stable batch of terminal runs older than the supplied timestamp. */
  listTerminalRunsBefore(query: {
    readonly terminalBefore: number;
    readonly limit: number;
  }): Promise<readonly Id[]> {
    const { terminalBefore, limit } = VaultTerminalRunsQuerySchema.parse(query);
    const runIds = [...this.terminalRuns.entries()]
      .filter(([, terminalAt]) => terminalAt < terminalBefore)
      .sort(([leftId, leftAt], [rightId, rightAt]) => {
        const timeOrder = leftAt - rightAt;
        return timeOrder === 0 ? leftId.localeCompare(rightId) : timeOrder;
      })
      .slice(0, limit)
      .map(([runId]) => runId);
    return Promise.resolve(runIds);
  }

  /** Purge entries, advance the version, and preserve counters so token numbers are never reused. */
  purge(runId: Id): Promise<number> {
    const removed = this.entries.get(runId)?.size ?? 0;
    this.entries.delete(runId);
    this.terminalRuns.delete(runId);
    if (removed > 0) {
      this.purgeEpochs.set(runId, (this.purgeEpochs.get(runId) ?? 0) + 1);
    }
    return Promise.resolve(removed);
  }

  /** Return the current entry count for a run. */
  stats(runId: Id): Promise<{ entries: number }> {
    return Promise.resolve({ entries: this.entries.get(runId)?.size ?? 0 });
  }
}
