# Event store content encryption

The `@rovinos/store` package provides the event-store contract and in-memory adapter.
Install `@rovinos/store-sqlite` for `SqliteEventStore` or `@rovinos/store-postgres` for
`PostgresEventStore`; each adapter package supplies only its own database driver.

SQLite and Postgres stores use `JsonContentCodec` by default. To encrypt persisted content, pass an
`AesGcmContentCodec` when opening the store:

```ts
const store = new SqliteEventStore(databasePath, new AesGcmContentCodec(keyProvider));
```

`keyProvider` implements the `KeyProvider` interface from `@rovinos/schemas`. Its
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

## Strict spend reservations

`SpendReservationStore` extends `EventStore` with transactions for reserving, dispatching, releasing,
and settling model-call spend. A reservation records its attempt id, integer micro-dollar estimate,
pricing revision, and all matched UTC quota periods. The caller must compute a finite upper-bound
estimate and round it up to an integer micro-dollar amount before reserving; the store rejects
missing estimates or pricing revisions and never calculates a fallback estimate.

`reserveSpend` checks settled ledger cost plus all outstanding reservations against every quota in
one transaction and appends the corresponding `model_request` before provider dispatch. Only a
`reserved` attempt can be released. Once marked `dispatching`, a call may have incurred a charge;
loss of its response or incomplete usage must keep the reservation `uncertain`, not refund it.
Settlement appends the `model_response`, applies the matching usage-ledger changes, and records the
complete `known` or `estimated` cost atomically. Duplicate identical settlements are idempotent;
conflicting responses fail. If reported cost exceeds the estimate, the full reported amount remains
in the ledger and can block subsequent reservations.

`InMemorySpendReservationStore` is the reference implementation for unit tests, not durable
production storage. Backend adapters can run the shared scenarios exported from
`@rovinos/store/testing` with `runSpendReservationConformance`. These transactions limit only
harness-admitted recorded spend; they do not impose a hard provider-billing cap.
