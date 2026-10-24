// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { Id, type KeyProvider } from "@rovinos/schemas";
import { runVaultConformance } from "./conformance.test-helpers.js";
import { PostgresVault } from "./postgres.js";

const fakePg = vi.hoisted(() => {
  interface Entry {
    run_id: string;
    token: string;
    entity_type: string;
    lookup: Buffer | null;
    value_enc: string;
    key_id: string;
    lookup_key_id: string;
    created_at: number;
  }
  interface State {
    migrations: string[];
    scopeKeys: Map<string, { wrapped_dek: Buffer; key_id: string; created_at: number }>;
    entries: Entry[];
    counters: Map<string, number>;
    epochs: Map<string, number>;
    terminalRuns: Map<string, number>;
  }
  const databases = new Map<string, State>();
  const unavailableSchemas = new Set<string>();
  let identityQueries = 0;
  let scopeKeyReads = 0;
  let conflictScopeKeyInsert = false;
  let conflictEntryInsert = false;
  const bufferValue = (value: unknown): Buffer => {
    if (!Buffer.isBuffer(value)) {
      throw new TypeError("Synthetic SQL value is not a buffer");
    }
    return value;
  };
  const stateFor = (schema: string): State => {
    let state = databases.get(schema);
    if (state === undefined) {
      state = {
        migrations: [],
        scopeKeys: new Map(),
        entries: [],
        counters: new Map(),
        epochs: new Map(),
        terminalRuns: new Map(),
      };
      databases.set(schema, state);
    }
    return state;
  };
  const equalBytes = (left: Buffer | null, right: unknown): boolean =>
    left !== null && Buffer.isBuffer(right) && left.equals(right);
  const handle = (
    schema: string,
    statement: string,
    values: unknown[],
    connectionString: string,
  ) => {
    const sql = statement.replaceAll(/\s+/g, " ").trim();
    const state = stateFor(schema);
    const rows: Record<string, unknown>[] = [];
    let rowCount = 0;
    if (sql.startsWith("SELECT (SELECT system_identifier::text FROM pg_control_system())")) {
      identityQueries += 1;
      const url = new URL(connectionString);
      const host =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" ? "loopback" : url.hostname;
      return {
        rows: [
          {
            system_identifier: host,
            database_name: url.pathname.slice(1),
            schema_name: schema,
            role_name: url.username,
          },
        ],
        rowCount: 1,
      };
    }
    if (
      sql === "BEGIN" ||
      sql === "COMMIT" ||
      sql === "ROLLBACK" ||
      sql.startsWith("SELECT pg_advisory_xact_lock") ||
      sql.startsWith("CREATE TABLE IF NOT EXISTS vault_schema_migrations") ||
      sql.startsWith("-- SPDX-License-Identifier: Apache-2.0")
    ) {
      return { rows, rowCount };
    }
    if (sql === "SELECT version FROM vault_schema_migrations") {
      return {
        rows: state.migrations.map((version) => ({ version })),
        rowCount: state.migrations.length,
      };
    }
    if (sql.startsWith("INSERT INTO vault_schema_migrations")) {
      state.migrations.push(String(values[0]));
      return { rows, rowCount: 1 };
    }
    if (sql.startsWith("SELECT wrapped_dek, key_id FROM vault_scope_keys")) {
      if (!sql.includes("FOR UPDATE")) {
        scopeKeyReads += 1;
      }
      const key = state.scopeKeys.get(String(values[0]));
      return {
        rows:
          key === undefined
            ? []
            : [{ wrapped_dek: Buffer.from(key.wrapped_dek), key_id: key.key_id }],
        rowCount: key === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("INSERT INTO vault_scope_keys")) {
      const scopeId = String(values[0]);
      if (!state.scopeKeys.has(scopeId)) {
        state.scopeKeys.set(scopeId, {
          wrapped_dek: Buffer.from(bufferValue(values[1])),
          key_id: String(values[2]),
          created_at: Number(values[3]),
        });
        if (conflictScopeKeyInsert) {
          conflictScopeKeyInsert = false;
        } else {
          rows.push({ scope_id: scopeId });
          rowCount = 1;
        }
      }
      return { rows, rowCount };
    }
    if (sql.startsWith("SELECT DISTINCT lookup_key_id FROM vault_entries")) {
      const keyIds = new Set(
        state.entries
          .filter((entry) => entry.run_id === String(values[0]))
          .map(({ lookup_key_id }) => lookup_key_id),
      );
      return {
        rows: [...keyIds].sort().map((lookup_key_id) => ({ lookup_key_id })),
        rowCount: keyIds.size,
      };
    }
    if (sql.startsWith("SELECT token FROM vault_entries")) {
      const excludedToken = typeof values[3] === "string" ? values[3] : "";
      const entry = state.entries.find(
        (candidate) =>
          candidate.run_id === String(values[0]) &&
          candidate.entity_type === String(values[1]) &&
          candidate.token !== excludedToken &&
          equalBytes(candidate.lookup, values[2]),
      );
      return {
        rows: entry === undefined ? [] : [{ token: entry.token }],
        rowCount: entry === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("INSERT INTO vault_counters")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      if (!state.counters.has(key)) {
        state.counters.set(key, 1);
      }
      return { rows, rowCount: 1 };
    }
    if (sql.startsWith("UPDATE vault_counters SET next_n = next_n + 1")) {
      const key = `${String(values[0])}:${String(values[1])}`;
      const previous = state.counters.get(key) ?? 1;
      state.counters.set(key, previous + 1);
      return { rows: [{ next_n: previous }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO vault_entries")) {
      const entry: Entry = {
        run_id: String(values[0]),
        token: String(values[1]),
        entity_type: String(values[2]),
        lookup: Buffer.from(bufferValue(values[3])),
        value_enc: String(values[4]),
        key_id: String(values[5]),
        lookup_key_id: String(values[6]),
        created_at: Number(values[7]),
      };
      const duplicate = state.entries.some(
        (candidate) =>
          candidate.run_id === entry.run_id &&
          candidate.entity_type === entry.entity_type &&
          equalBytes(candidate.lookup, entry.lookup),
      );
      if (!duplicate) {
        state.entries.push(entry);
        if (conflictEntryInsert) {
          conflictEntryInsert = false;
        } else {
          rows.push({ token: entry.token });
          rowCount = 1;
        }
      }
      return { rows, rowCount };
    }
    if (
      sql.startsWith(
        "SELECT run_id, token, entity_type, lookup, value_enc, key_id, lookup_key_id FROM vault_entries",
      )
    ) {
      if (sql.includes("token = $2")) {
        const entry = state.entries.find(
          ({ run_id, token }) => run_id === String(values[0]) && token === String(values[1]),
        );
        return {
          rows: entry === undefined ? [] : [{ ...entry }],
          rowCount: entry === undefined ? 0 : 1,
        };
      }
      if (sql.includes("ORDER BY token")) {
        const entries = state.entries
          .filter(({ run_id }) => run_id === String(values[0]))
          .sort((left, right) => left.token.localeCompare(right.token));
        return { rows: entries.map((entry) => ({ ...entry })), rowCount: entries.length };
      }
      const [target, cursorRun, cursorToken, limit] = values;
      const afterRunId = typeof cursorRun === "string" ? cursorRun : undefined;
      const afterToken = typeof cursorToken === "string" ? cursorToken : "";
      const entries = state.entries
        .filter(
          (entry) =>
            (entry.key_id !== String(target) || entry.lookup_key_id !== String(target)) &&
            (afterRunId === undefined ||
              entry.run_id > afterRunId ||
              (entry.run_id === afterRunId && entry.token > afterToken)),
        )
        .sort((left, right) => {
          const runOrder = left.run_id.localeCompare(right.run_id);
          return runOrder === 0 ? left.token.localeCompare(right.token) : runOrder;
        })
        .slice(0, Number(limit));
      return { rows: entries.map((entry) => ({ ...entry })), rowCount: entries.length };
    }
    if (sql.startsWith("SELECT COALESCE((SELECT SUM(next_n - 1)")) {
      const runId = String(values[0]);
      const count = [...state.counters.entries()]
        .filter(([key]) => key.startsWith(`${runId}:`))
        .reduce((sum, [, next]) => sum + next - 1, 0);
      return { rows: [{ version: count + (state.epochs.get(runId) ?? 0) }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO run_meta")) {
      const runId = String(values[0]);
      const terminalAt = Number(values[1]);
      state.terminalRuns.set(
        runId,
        Math.min(state.terminalRuns.get(runId) ?? terminalAt, terminalAt),
      );
      return { rows, rowCount: 1 };
    }
    if (sql.startsWith("SELECT run_id FROM run_meta")) {
      const eligible = [...state.terminalRuns.entries()]
        .filter(([, ts]) => ts < Number(values[0]))
        .sort(([leftId, leftTs], [rightId, rightTs]) => {
          const timeOrder = leftTs - rightTs;
          return timeOrder === 0 ? leftId.localeCompare(rightId) : timeOrder;
        })
        .slice(0, Number(values[1]))
        .map(([run_id]) => ({ run_id }));
      return { rows: eligible, rowCount: eligible.length };
    }
    if (sql.startsWith("DELETE FROM vault_scope_keys")) {
      return { rows, rowCount: Number(state.scopeKeys.delete(String(values[0]))) };
    }
    if (sql.startsWith("DELETE FROM vault_entries")) {
      const before = state.entries.length;
      state.entries = state.entries.filter(({ run_id }) => run_id !== String(values[0]));
      return { rows, rowCount: before - state.entries.length };
    }
    if (sql.startsWith("DELETE FROM run_meta")) {
      return { rows, rowCount: Number(state.terminalRuns.delete(String(values[0]))) };
    }
    if (sql.startsWith("INSERT INTO vault_purge_epochs")) {
      const runId = String(values[0]);
      state.epochs.set(runId, (state.epochs.get(runId) ?? 0) + 1);
      return { rows, rowCount: 1 };
    }
    if (sql.startsWith("SELECT COUNT(*) AS entries FROM vault_entries")) {
      const entries = state.entries.filter(({ run_id }) => run_id === String(values[0])).length;
      return { rows: [{ entries }], rowCount: 1 };
    }
    if (
      sql.startsWith(
        "SELECT token FROM vault_entries WHERE run_id = $1 AND entity_type = $2 AND lookup = $3 AND token <> $4",
      )
    ) {
      const match = state.entries.find(
        (entry) =>
          entry.run_id === String(values[0]) &&
          entry.entity_type === String(values[1]) &&
          entry.token !== String(values[3]) &&
          equalBytes(entry.lookup, values[2]),
      );
      return {
        rows: match === undefined ? [] : [{ token: match.token }],
        rowCount: match === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("UPDATE vault_entries SET key_id = $1, lookup = $2")) {
      const entry = state.entries.find(
        ({ run_id, token, key_id, lookup_key_id, value_enc }) =>
          run_id === String(values[2]) &&
          token === String(values[3]) &&
          key_id === String(values[4]) &&
          lookup_key_id === String(values[5]) &&
          value_enc === String(values[6]),
      );
      if (entry !== undefined) {
        entry.key_id = String(values[0]);
        entry.lookup = values[1] === null ? null : Buffer.from(bufferValue(values[1]));
        entry.lookup_key_id = String(values[0]);
        rowCount = 1;
      }
      return { rows, rowCount };
    }
    if (sql.startsWith("UPDATE vault_scope_keys SET wrapped_dek")) {
      const key = state.scopeKeys.get(String(values[2]));
      if (key?.key_id === String(values[3]) && key.wrapped_dek.equals(bufferValue(values[4]))) {
        key.wrapped_dek = Buffer.from(bufferValue(values[0]));
        key.key_id = String(values[1]);
        rowCount = 1;
      }
      return { rows, rowCount };
    }
    if (sql.startsWith("UPDATE vault_entries SET key_id = $1 WHERE run_id = $2")) {
      for (const entry of state.entries) {
        if (entry.run_id === String(values[1])) {
          entry.key_id = String(values[0]);
          rowCount += 1;
        }
      }
      return { rows, rowCount };
    }
    if (sql.startsWith("SELECT key_id, COUNT(*) AS count FROM (")) {
      const references = new Set<string>();
      for (const entry of state.entries) {
        references.add(`${entry.key_id}:${entry.run_id}:${entry.token}`);
        references.add(`${entry.lookup_key_id}:${entry.run_id}:${entry.token}`);
      }
      const counts = new Map<string, number>();
      for (const reference of references) {
        const keyId = reference.slice(0, reference.indexOf(":"));
        counts.set(keyId, (counts.get(keyId) ?? 0) + 1);
      }
      const grouped = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
      return {
        rows: grouped.map(([key_id, count]) => ({ key_id, count })),
        rowCount: grouped.length,
      };
    }
    throw new Error("Unhandled synthetic SQL");
  };
  return {
    databases,
    unavailableSchemas,
    get identityQueries() {
      return identityQueries;
    },
    get scopeKeyReads() {
      return scopeKeyReads;
    },
    resetReadCounts() {
      identityQueries = 0;
      scopeKeyReads = 0;
      conflictScopeKeyInsert = false;
      conflictEntryInsert = false;
    },
    conflictNextScopeKeyInsert() {
      conflictScopeKeyInsert = true;
    },
    conflictNextEntryInsert() {
      conflictEntryInsert = true;
    },
    handle,
  };
});

vi.mock("pg", () => ({
  Pool: class {
    readonly schema: string;
    readonly connectionString: string;

    constructor(options: { readonly connectionString: string; readonly options?: string }) {
      this.connectionString = options.connectionString;
      this.schema = options.options?.match(/search_path="([^"]+)"/)?.[1] ?? "public";
    }

    on(): this {
      return this;
    }

    query(statement: string, values: unknown[] = []) {
      return Promise.resolve(fakePg.handle(this.schema, statement, values, this.connectionString));
    }

    connect() {
      if (fakePg.unavailableSchemas.has(this.schema)) {
        return Promise.reject(new Error("synthetic connection failure"));
      }
      return Promise.resolve({
        query: (statement: string, values: unknown[] = []) =>
          Promise.resolve(fakePg.handle(this.schema, statement, values, this.connectionString)),
        release: () => undefined,
      });
    }

    end(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const runId = Id.parse("A".repeat(26));
let schemaIndex = 0;

function keyProvider(): KeyProvider & { setCurrentKeyId(keyId: string): void } {
  let current = "key-a";
  const keys = new Map([
    ["key-a", new Uint8Array(32).fill(61)],
    ["key-b", new Uint8Array(32).fill(62)],
  ]);
  return {
    currentKeyId: () => current,
    getKey: (keyId) => {
      const key = keys.get(keyId);
      return key === undefined
        ? Promise.reject(new Error("synthetic key is missing"))
        : Promise.resolve(Uint8Array.from(key));
    },
    setCurrentKeyId: (keyId) => {
      current = keyId;
    },
  };
}

function nextSchema(): string {
  schemaIndex += 1;
  return `unit_vault_${String(schemaIndex)}`;
}

function constructionError(create: () => unknown): unknown {
  try {
    create();
  } catch (error) {
    return error;
  }
  return undefined;
}

function vaultFor(
  schema: string,
  keys: KeyProvider = keyProvider(),
  connectionString = "postgresql://vault@vault-db/harness_vault",
  storeConnectionString = "postgresql://store@store-db/harness",
  storeSchema = "public",
): PostgresVault {
  return new PostgresVault(connectionString, keys, {
    storeConnectionString,
    schema,
    storeSchema,
  });
}

beforeEach(() => {
  fakePg.unavailableSchemas.clear();
  fakePg.resetReadCounts();
});

runVaultConformance("PostgresVault with a connection-pool double", () => {
  const vault = vaultFor(nextSchema());
  return Promise.resolve({ vault, cleanup: () => vault.close() });
});

it("uses scope-key rewrapping without re-encrypting values", async () => {
  const schema = nextSchema();
  const keys = keyProvider();
  const vault = vaultFor(schema, keys);
  const token = await vault.put(runId, "email", "alice@example.test");
  const state = fakePg.databases.get(schema);
  const originalValue = state?.entries[0]?.value_enc;
  const originalWrapped = state?.scopeKeys.get(runId)?.wrapped_dek;

  keys.setCurrentKeyId("key-b");
  await expect(vault.reencryptBatch({ targetKeyId: "key-b" })).resolves.toMatchObject({
    processed: 1,
  });
  await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBe("alice@example.test");
  expect(state?.entries[0]?.value_enc).toBe(originalValue);
  expect(state?.scopeKeys.get(runId)?.wrapped_dek).not.toEqual(originalWrapped);
  await expect(vault.countRowsByKey()).resolves.toEqual([{ keyId: "key-b", count: 1 }]);
  await vault.close();
});

it("rejects a shared database/schema, invalid configuration, and unavailable database", async () => {
  expect(
    constructionError(() =>
      vaultFor(
        "public",
        keyProvider(),
        "postgresql://vault@db/harness",
        "postgresql://store@db/harness",
        "public",
      ),
    ),
  ).toMatchObject({ code: "vault_shares_store_database" });
  expect(
    constructionError(() =>
      vaultFor(
        "vault_schema",
        keyProvider(),
        "postgresql://vault@db/harness",
        "postgresql://vault@db/harness",
        "event_schema",
      ),
    ),
  ).toMatchObject({ code: "vault_shares_store_database" });
  expect(
    constructionError(() =>
      vaultFor("public", keyProvider(), "sqlite:///not-postgres", "postgresql://store@db/harness"),
    ),
  ).toMatchObject({ code: "vault_unavailable" });

  const schema = nextSchema();
  fakePg.unavailableSchemas.add(schema);
  const vault = vaultFor(schema);
  await expect(vault.stats(runId)).rejects.toMatchObject({ code: "vault_unavailable" });
  await vault.close();
});

it("allows a dedicated role and schema in the same database", async () => {
  const vault = vaultFor(
    "vault_schema",
    keyProvider(),
    "postgresql://vault@db/harness",
    "postgresql://store@db/harness",
    "event_schema",
  );
  await expect(vault.stats(runId)).resolves.toEqual({ entries: 0 });
  await vault.close();
});

it("checks physical server identity and refuses aliased event-store connections", async () => {
  const vault = vaultFor(
    "public",
    keyProvider(),
    "postgresql://vault@127.0.0.1/harness",
    "postgresql://store@localhost/harness",
  );
  await expect(vault.stats(runId)).rejects.toMatchObject({
    code: "vault_shares_store_database",
  });
  expect(fakePg.identityQueries).toBe(2);
  await vault.close();
});

it("fetches one scope key per value-list operation", async () => {
  const vault = vaultFor(nextSchema());
  await vault.put(runId, "email", "alice@example.test");
  await vault.put(runId, "email", "bob@example.test");
  fakePg.resetReadCounts();

  await expect(vault.listRawValues(runId)).resolves.toEqual([
    "alice@example.test",
    "bob@example.test",
  ]);
  expect(fakePg.scopeKeyReads).toBe(1);
  await expect(vault.listRawValueEntries(runId)).resolves.toEqual([
    { entityType: "email", rawValue: "alice@example.test" },
    { entityType: "email", rawValue: "bob@example.test" },
  ]);
  expect(fakePg.scopeKeyReads).toBe(2);
  await vault.close();
});

it("covers empty lists and read failures", async () => {
  const schema = nextSchema();
  const vault = vaultFor(schema);
  const emptyRunId = Id.parse("B".repeat(26));
  await expect(vault.listRawValues(emptyRunId)).resolves.toEqual([]);
  await expect(vault.listRawValueEntries(emptyRunId)).resolves.toEqual([]);
  await vault.close();
  const failedSchema = nextSchema();
  fakePg.unavailableSchemas.add(failedSchema);
  const unavailable = vaultFor(failedSchema);
  await expect(unavailable.listRawValues(runId)).rejects.toMatchObject({
    code: "vault_unavailable",
  });
  await unavailable.close();
});

it("recovers concurrent inserts for scope keys and entries", async () => {
  const schema = nextSchema();
  const vault = vaultFor(schema);
  fakePg.conflictNextScopeKeyInsert();
  fakePg.conflictNextEntryInsert();
  await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe("<EMAIL_1>");
  await vault.close();
});

it("maps invalid counters and stored tokens to closed vault errors", async () => {
  const schema = nextSchema();
  const keys = keyProvider();
  const vault = vaultFor(schema, keys);
  await vault.stats(runId);
  const state = fakePg.databases.get(schema);
  state?.counters.set(`${runId}:EMAIL`, Number.NaN);
  await expect(vault.put(runId, "email", "alice@example.test")).rejects.toMatchObject({
    code: "vault_unavailable",
  });
  state?.counters.delete(`${runId}:EMAIL`);
  await vault.put(runId, "email", "alice@example.test");
  keys.setCurrentKeyId("key-b");
  await expect(vault.put(runId, "email", "alice@example.test")).resolves.toBe("<EMAIL_1>");
  keys.setCurrentKeyId("key-a");
  const entry = state?.entries[0];
  if (entry !== undefined) {
    entry.token = "not-a-token";
  }
  await expect(vault.put(runId, "email", "alice@example.test")).rejects.toMatchObject({
    code: "vault_unavailable",
  });
  await vault.close();
});

it("validates values and masks corrupt ciphertext and unsupported migration history", async () => {
  const schema = nextSchema();
  const vault = vaultFor(schema);
  await expect(vault.put(runId, "email", "  ")).rejects.toMatchObject({
    code: "vault_value_empty",
  });
  await expect(vault.put(runId, "email", "x".repeat(8193))).rejects.toMatchObject({
    code: "vault_value_too_large",
  });
  const rawCanary = "postgres-vault-error-canary-alice@example.test";
  let writeError: unknown;
  try {
    await vault.put(runId, "email", `${rawCanary}${"x".repeat(8193)}`);
  } catch (error) {
    writeError = error;
  }
  expect(writeError).toMatchObject({ code: "vault_value_too_large" });
  expect(String(writeError)).not.toContain(rawCanary);
  await expect(vault.resolve(runId, "<EMAIL_1>", { boundary: "ui" })).resolves.toBeUndefined();
  await vault.put(runId, "email", "alice@example.test");
  const entry = fakePg.databases.get(schema)?.entries[0];
  if (entry !== undefined) {
    entry.value_enc = "not-base64";
  }
  await expect(vault.resolve(runId, "<EMAIL_1>", { boundary: "ui" })).rejects.toMatchObject({
    code: "vault_decrypt_failed",
  });
  await vault.close();

  const unsupportedSchema = nextSchema();
  fakePg.databases.set(unsupportedSchema, {
    migrations: ["0002_future"],
    scopeKeys: new Map(),
    entries: [],
    counters: new Map(),
    epochs: new Map(),
    terminalRuns: new Map(),
  });
  const unsupported = vaultFor(unsupportedSchema);
  await expect(unsupported.stats(runId)).rejects.toMatchObject({
    code: "vault_migration_newer_than_code",
  });
  await unsupported.close();
});
