# AGENTS.md: packages/crypto

Small shared crypto helpers: AES-256-GCM, HKDF, HMAC. Leaf package created in task 12.2.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [TASKS.md](./TASKS.md) (specs in other folders): tasks 7.9 (refactor), 12.2, 12.8, 19.6, 6.8, 12.9

## Allowed internal imports

- None (leaf package).
- Source: `docs/engineering/layers.json` (lint enforces it; change it there, never here).

<!-- END GENERATED: agents-index -->

## Boundaries

- External code: `node:crypto` only. Never implement primitives yourself.

## Rules

- Never implement primitives yourself; wrap `node:crypto` only.
- Never reuse an IV. AAD must bind ciphertext to its row (run id + seq/token).
- Never log keys, plaintext, or ciphertext. Zero key buffers when practical.
- Failures throw coded errors without details (`content_decrypt_failed`).

## Testing

- Known-answer vectors; tamper and wrong-AAD tests; IV uniqueness test.
