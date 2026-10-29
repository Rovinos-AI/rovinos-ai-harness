# API documentation and compatibility

The generated reference in `docs/api/` describes the publishable package entry points: the CLI's
`programmatic` export and the SDK, PostgreSQL store, and SQLite store package indexes. Anything
exported from one of those entry points is public and is included in API documentation coverage.
The shared store contracts used by the adapters are included as supporting reference material, but
are not counted as publishable API exports.

Mark a declaration that is intentionally not part of the supported API with a TSDoc `@internal`
tag. TypeDoc omits those declarations from the generated reference and the coverage calculation.
Do not use `@internal` to avoid documenting an API that consumers are expected to use.

Changes to a public API must include a Changeset. Use a `major` Changeset for breaking API changes,
`minor` for backward-compatible additions, and `patch` for compatible fixes and documentation-only
changes.
