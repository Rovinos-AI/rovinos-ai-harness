# AGENTS.md: scripts

Repo scripts: CI checks, generators, security and docs tooling.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

<!-- END GENERATED: agents-index -->

## Boundaries

- Node/TypeScript or shell. May import workspace packages only through their public exports.

## Rules

- Separate pure evaluators from tool invocations so logic is unit-testable (see `check-licenses`, `check-vulns`).
- Scripts that scan or generate must support a `--check` mode for CI drift detection where applicable.
- No network calls unless the script's purpose requires it, and then behind an explicit flag.
- Output must never include secrets or content; redact by default.

## Testing

- Each script has a co-located `*.test.ts` using temp directories and injected clocks.
