# AGENTS.md: packages/pii

Entity detection, policy evaluation, tokenization and detokenization, and boundary adapters (model input, tool input/output, storage).

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->
## Specs and task ids
- [epic-13-pii-tokenizer.md](./epic-13-pii-tokenizer.md): tasks 13.1-13.11

## Allowed internal imports
- `@harness/schemas`, `@harness/telemetry`, `@harness/vault`. Nothing else from `@harness/*`.
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).
<!-- END GENERATED: agents-index -->

## Rules
- Fail closed: detector or vault failure fails the operation; never pass raw text through.
- Detokenize only at allowlisted tool argument pointers; everything else stays tokenized.
- Detectors must be linear-time (no catastrophic regexes). Run the pathological-input timing test.
- Errors and summaries carry entity types and counts only, never values.
- Never claim complete detection in docs or messages; see `docs/guarantees.md`.

## Testing
- Corpus precision/recall gate (`scripts/pii-report.ts`); canary property tests.

## Gotchas
- Pipeline order matters: tokenize args, then policy on tokenized args, then detokenize allowlisted args, then execute, then tokenize result. Detokenizing before policy runs is a privacy bug.
- Detokenized args are an in-memory deep copy for `execute` only. The recorded `tool_intent.args` keep tokens; never log or cache the raw copy.
- Leave existing tokens untouched; re-detecting inside `<EMAIL_1>` creates nested tokens.
- `allow` is invalid at the `storage` boundary; storage always tokenizes.
