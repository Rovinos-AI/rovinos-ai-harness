# AGENTS.md: tools/eslint-plugin-harness

Custom ESLint rules enforcing project invariants.

<!-- BEGIN GENERATED: agents-index (node scripts/gen-agents-index.mjs) -->

<!-- END GENERATED: agents-index -->

## Boundaries

- Depends only on ESLint and TypeScript-ESLint.

## Rules

- Each rule has `RuleTester` valid and invalid cases and a message that names the correct API.
- Rules are enabled as errors in the root config; never disable them with comments without a reason.

## Testing

- `@typescript-eslint/rule-tester` suites.
