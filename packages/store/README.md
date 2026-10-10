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
