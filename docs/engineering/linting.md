# Linting and formatting

`yarn lint` runs ESLint and Prettier. Every enabled ESLint rule has error severity; no rule is
warning-level. Prettier owns formatting (`printWidth: 100`, double quotes, and trailing commas).
Markdown remains outside Prettier because it is handled by the documentation lint stage.

## Rule groups

- TypeScript uses the strict and stylistic type-aware presets and `projectService`. Explicit checks
  prohibit unsafe types and assertions, unchecked promises, weak boolean conditions, incomplete
  switches, and untyped public boundaries.
- Core JavaScript and TypeScript rules enforce straightforward control flow, named exports, bounded
  function complexity, and no console or dynamic-code execution.
- Import, Node, Promise, RegExp, and Unicorn rules enforce package hygiene, safe regular expressions,
  current Node APIs, and predictable error handling.
- `harness/import-direction` reads `docs/engineering/layers.json`; cross-package imports must follow
  that table and use `@harness/*` package names.
- Package restrictions keep telemetry SDKs and parsers behind approved boundaries. Browser paths
  also reject Node globals/imports and unsafe HTML sinks. Test files use Vitest rules while keeping
  TypeScript safety checks enabled.

The ESLint config and Vitest workspace config must use default exports for their loaders. The
dependency-free `scripts/gen-agents-index.mjs` retains its JSON parser exception because it runs
before package dependencies are installed and validates repository indexes. These are
config-level exceptions, not patterns to copy into application code; task 1.12 supplies the schema
parsing APIs. The plugin entry point alone opts out of `import-x/no-relative-packages` because it
loads the canonical layer table outside `packages/`; the custom rule enforces relative boundaries
inside packages.

`packages/schemas/tsconfig.json` is the package tsconfig pattern: extend `tsconfig.base.json`, set
package-local `rootDir`/`outDir`, and include package source. The lint plugin has a matching config
so the type-aware service can check its test fixtures.

## Suppressions and rule changes

Inline ESLint suppressions must include a description after `--`, for example:

```ts
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- validates an SDK boundary
```

Unused suppressions fail lint. `harness/*`, security-critical rules, and package-boundary rules
cannot be disabled inline; change their configuration only through a reviewed PR. A PR that
relaxes or disables a rule must explain why, its scope, and the replacement safeguard. Do not
weaken project guarantees to silence an isolated finding.
