# Reference retrieval

Install `@rovinos/sdk`, `@rovinos/extensions`, and `@rovinos/extension-retrieval` only when
applications need this optional reference tool. The example uses an explicitly supplied synthetic
corpus and deterministic local provider fixture; it does not require credentials, network access,
an embedding model, or a vector database.

The host scopes the corpus and supplies the `tools.contribute` grant. The tool still passes through
the SDK's ordinary model selection and policy path. Returned records carry corpus, scope, record,
and source provenance, and retrieved text remains untrusted content. SDK boundaries own
tokenization and event recording.

This package is trusted in-process code, not a sandbox or hosted tenant isolation boundary. Replay
consumes recorded model/tool results and does not contact an external retrieval service or repeat
external effects.
