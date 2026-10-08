# AGENTS.md: security

Security tooling configuration: Semgrep rules, cosign public key, scanner policies.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

## Specs and task ids

- [epic-22-security-hardening.md](./epic-22-security-hardening.md): tasks 22.1-22.6

<!-- END GENERATED: agents-index -->

## Also touched by

- 19.1 ([epic-19](../packages/sandbox/epic-19-sandbox-and-container-execution.md)) defines the sandbox threat ids that security tests cite.

## Boundaries

- Configuration only.

## Rules

- Every Semgrep rule has `# ruleid:` and `# ok:` fixtures run by `semgrep --test`.
- `nosemgrep` suppressions require a written reason; exceptions in vulnerability policies require an owner and an expiry date.
- Pin scanner versions. Each gate keeps a positive control that proves it can fail.
- Never commit private keys; `cosign.pub` is the only key material allowed here.
