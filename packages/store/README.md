# Event store content encryption

SQLite and Postgres stores use `JsonContentCodec` by default. To encrypt persisted content, pass an
`AesGcmContentCodec` when opening the store:

```ts
const store = new SqliteEventStore(databasePath, new AesGcmContentCodec(keyProvider));
```

`keyProvider` implements the `KeyProvider` interface from `@harness/schemas`. Its
`currentKeyId()` returns the identifier for new content, and `getKey(keyId)` resolves the
corresponding 32-byte AES-256 key. If a key is unavailable, `getKey` must reject with an error
whose code is `key_not_found`.

A persistent store's encryption mode is recorded on first open and is fixed thereafter. Opening
the same store with a different mode, including switching an empty plaintext store to encryption,
fails with `store_encryption_mismatch`.

## Live subscriptions

`EventStore.watch(runId, { fromSeq, signal })` yields decoded events from the requested sequence,
then follows appends in order until the run reaches a terminal status or the signal aborts.
`watchRuns({ statuses, signal })` yields current run summaries followed by status transitions.
SQLite adapters poll for appends made through other processes every 250 ms by default; configure
`pollIntervalMs` in `SqliteEventStore` options to change that interval.
