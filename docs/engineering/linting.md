# Linting and formatting

`yarn lint` runs Markdownlint, ESLint (including YAML), ShellCheck, hadolint, EditorConfig
Checker, cspell, Prettier, and dependency checks. Every enabled ESLint rule has error severity;
no rule is warning-level. Prettier owns formatting (`printWidth: 100`, double quotes, and trailing
commas). Markdown remains outside Prettier because it is handled by markdownlint.

Container-based checks use immutable, multi-architecture hadolint and EditorConfig Checker images.
By default Docker uses only images already present locally; set `LINT_PULL_IMAGES=1` to explicitly
pull them. CI sets this flag. Local development may instead set `LINT_SKIP_CONTAINERS=1` to skip
container checks with a warning. ShellCheck 0.11.0 is pinned through mise's Aqua backend and is
required for linting. Its GPL-3.0 license applies to this developer/CI tool only; ShellCheck is not
an application dependency and is not shipped by the harness.

Markdownlint starts from its defaults, disables only line-length checking, allows HTML comments
used as repository markers, and requires language tags on fenced code blocks. YAML is linted by
the ESLint YAML plugin with two-space indentation; duplicate keys are rejected by its YAML parser.
cspell checks Markdown and comments/string literals in `packages/*/src`; add new project-specific
words deliberately to `docs/engineering/project-words.txt`.

## Rule groups

- TypeScript uses the strict and stylistic type-aware presets and `projectService`. Explicit checks
  prohibit unsafe types and assertions, unchecked promises, weak boolean conditions, incomplete
  switches, and untyped public boundaries.
- Core JavaScript and TypeScript rules enforce straightforward control flow, named exports, bounded
  function complexity, and no console or dynamic-code execution.
- Import, Node, Promise, RegExp, and Unicorn rules enforce package hygiene, safe regular expressions,
  current Node APIs, and predictable error handling.
- `harness/import-direction` reads `docs/engineering/layers.json`; cross-package imports must follow
  that table and use `@rovinos/*` package names.
- `harness/no-raw-tracer` prevents raw OpenTelemetry SDK imports, `trace.getTracer`, raw span
  creation (`startSpan`/`startActiveSpan`), exception recording (`recordException`), renaming
  (`updateName`), and span attribute mutation (`setAttribute`/`setAttributes`) outside approved
  files. Attribute mutations are identified through span-producing calls and variable bindings,
  including variables initialized or assigned from `getSpan`, `getActiveSpan`, `start`, `startSpan`,
  and `startActiveSpan`, as well as parameters annotated as `Span`. Unrelated DOM attribute updates
  are not span mutations.

  Create spans through registered definitions: use `definition.start(attributes)` for direct span
  work or `withSpan(definition, attributes, run)` to scope work. Update the active span through
  `setActiveSpanAttribute`; do not reach into raw OpenTelemetry span APIs.

  The default allowlist is limited to `packages/telemetry/src/{registry,log-registry,tracer,sdk,testing}.ts`,
  `**/*.test.ts`, `test/canary/telemetry.ts`, `test/fixtures/sample-mcp-server/server.ts`, and
  `test/mcp-servers.int-client.test.mjs`. The registry and telemetry SDK files implement the
  approved boundary; test support and named fixtures need raw spans for setup or leak probes.
  Extend it only for a concrete boundary or test fixture that cannot use the approved API, use the
  narrowest exact path possible, and add a RuleTester regression demonstrating why the exception is
  required. The rule's `allowedFiles` option configures this list; patterns are matched relative to
  ESLint's configured working directory.
- Package restrictions keep telemetry SDKs and parsers behind approved boundaries. Browser paths
  also reject Node globals/imports and unsafe HTML sinks. Test files use Vitest rules while keeping
  TypeScript safety checks enabled.

The ESLint config and Vitest workspace config must use default exports for their loaders.
`scripts/gen-agents-index.mjs` validates `layers.json` through the schema parsing API and is run
through its Yarn commands, which build `@rovinos/schemas` first. The root ESLint config also parses
the canonical layer table through that API and injects it into the plugin; the plugin entry point
alone opts out of `import-x/no-relative-packages` because it is outside `packages/`.

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
