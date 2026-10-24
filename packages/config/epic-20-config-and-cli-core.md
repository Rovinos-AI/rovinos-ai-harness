# Epic #20: Config and CLI core

**Goal:** one validated configuration model, one CLI framework that every later command plugs into, secrets that cannot leak, and a logger that cannot carry free text. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 20.1 to 20.5, all size S.

Shared design for this epic:

- Config fragments are owned by the package they configure (for example the servers fragment arrives in task 6.1) and exported from `@rovinos/schemas/src/config/<name>.ts`. `@rovinos/config` only composes them. This avoids dependency cycles. In this epic every fragment except `run` is a stub `z.object({}).strict()` that owners replace.
- Config file format: YAML (`harness.config.yaml`) or JSON, discovered via `--config`, then `HARNESS_CONFIG`, then `./harness.config.yaml`.

---

## 20.1 Zod config schema with environment overrides and clear validation errors

**Parent:** #20 Config and CLI core
**Task Description:** Create `@rovinos/config`: load a config file, apply environment overrides, validate with Zod, return a deeply frozen typed object, and produce actionable errors.
**Expected Inputs:** Path to a YAML/JSON file (optional), `process.env`, fragment schemas from `@rovinos/schemas`.
**Expected Output:** `packages/config` exporting `loadConfig(opts): Promise<HarnessConfig>`, `HarnessConfigSchema`, `ConfigError` (code `config_invalid`), `formatConfigIssues(issues): string[]`; `packages/schemas/src/config/{run,store,models,servers,policy,pii,telemetry,sandbox}.ts` (stubs except `run`); `docs/configuration.md` skeleton.
**Dependencies:** `yaml`, `zod`.
**Items it depends on:** 1.1, 1.2.
**Implementation guidance:**

1. `run` fragment: `{ budgets: { maxSteps: int>0 default 200, maxCostUsd: number>0 optional, maxWallClockMs: int>0 default 3_600_000 } }`. Others stub as strict empty objects with a header comment naming the owning task.
2. `HarnessConfigSchema = z.object({ run, store, models, servers: z.array(...).default([]), policy, pii, telemetry, sandbox }).strict()`. Unknown keys are errors.
3. Env override convention: `HARNESS__<PATH>__<KEY>=value` with `__` separating path segments, segments lower-cased and camelCased (`HARNESS__RUN__BUDGETS__MAXSTEPS=50`). Parse overrides into a nested object and deep-merge over the file object before validation. Values stay strings; fragments use `z.coerce.number()` / explicit boolean preprocessors only where the field is numeric/boolean. Document that arrays cannot be overridden by env.
4. Error formatting: for each Zod issue produce `path.to.field: <what was expected> (code)`. Never include the received value (it may be a secret).
5. Deep-freeze the result with a small recursive `Object.freeze` helper.
6. Loader is async and takes injected `readFile` and `env` for testing.
**Tests to write:** `packages/config/src/load.test.ts`: file-only; env override wins; nested override; unknown key rejected; numeric coercion; multiple issues reported at once; received value never appears in error text; frozen object throws on mutation in strict mode; discovery order of file paths.
**Acceptance Criteria:**

- [ ] `loadConfig` returns typed config for a valid file and throws `ConfigError` listing every invalid path otherwise.
- [ ] Env override precedence documented and tested.
- [ ] Error output never contains submitted values.

---

## 20.2 CLI framework, help, and JSON output mode

**Parent:** #20 Config and CLI core
**Task Description:** Build the `harness` CLI skeleton with a command registration pattern, global flags, stable exit codes, and a JSON output mode.
**Expected Inputs:** `process.argv`, loaded config (20.1).
**Expected Output:** `packages/cli/src/{main.ts,command.ts,output.ts,exit-codes.ts}`, `harness --help`, `harness --version`, global flags `--config`, `--json`, `--log-level`.
**Dependencies:** `commander`.
**Items it depends on:** 1.3, 20.1.
**Implementation guidance:**

1. Define `interface CommandModule { name: string; register(program: Command, ctx: CliContext): void }` and `CliContext { loadConfig(): Promise<HarnessConfig>; out: Output; clock: Clock }`. `main.ts` builds the context, imports a static array `COMMANDS: CommandModule[]` (empty now; later epics append), and runs `program.parseAsync`.
2. `output.ts` is the only file allowed to write to stdout/stderr (add an ESLint override allowing `process.stdout.write` here, and a lint rule/test that other files in `packages/cli` do not). API: `out.print(text)`, `out.table(rows)`, `out.json(obj)`, `out.error(code, hint?)`. In `--json` mode, commands print exactly one JSON document to stdout and nothing else; human text goes to stderr only. Every command's `--json` output has a Zod schema in `packages/schemas/src/cli/<command>.ts`; `out.json(schema, value)` validates before printing, and `docs/cli.md` documents the JSON Schema generated from it (CONVENTIONS 3.10).
3. Exit codes enum: `0 ok`, `1 failure`, `2 usage`, `3 config_invalid`, `4 policy_denied` (also `approver_is_requester`, 17.9), `5 suspended` (run waiting for approval or human input), `6 budget_exceeded`, `7 not_found_or_resolved` (approval or input not found or already resolved, 17.5 and 25.6), `8 replay_failed` (9.5), `9 quota_exceeded` (24.7). Map `HarnessError.code` to exit codes in one table; later tasks add codes only by updating this table and `docs/cli.md`.
4. Unknown commands show help and exit 2. Unhandled errors print only the error `code` (never the message) and exit 1.
5. Keep command modules lazily imported to keep `--help` fast.
**Tests to write:** `packages/cli/src/main.test.ts` invoking `main(argv, fakeCtx)`: help text lists registered commands; `--json` emits a single parseable JSON object; usage error exit code 2; error mapping table; a test asserting no other file under `packages/cli/src` references `process.stdout`.
**Acceptance Criteria:**

- [ ] `harness --help` and `--version` work from the built container.
- [ ] `--json` guarantees machine-parseable stdout.
- [ ] Exit codes stable and documented in `docs/cli.md`.

---

## 20.3 Secrets handling: references only

**Parent:** #20 Config and CLI core
**Task Description:** Ensure secrets are never stored in config or printed: config holds references, a resolver turns them into opaque `Secret` objects at use time.
**Expected Inputs:** `SecretRef` strings in config; process env; optional file paths; (later) Azure Key Vault.
**Expected Output:** `packages/schemas/src/secret-ref.ts` (`SecretRefSchema`), `packages/config/src/secrets.ts` (`Secret` class, `SecretResolver` interface, `EnvSecretResolver`, `FileSecretResolver`), inline-secret detection in the config loader.
**Dependencies:** `zod`.
**Items it depends on:** 20.1.
**Implementation guidance:**

1. `SecretRef` string forms: `env:NAME`, `file:/absolute/path`, `akv:<vault>/<secret>` (resolver for `akv` is added in task 12.4; here return `secret_resolver_unavailable`). Parse with a regex per scheme; reject others with `secret_ref_invalid`.
2. `class Secret { reveal(): string; toString() => "[REDACTED]"; toJSON() => "[REDACTED]"; [Symbol.for("nodejs.util.inspect.custom")]() => "[REDACTED]" }`. Value stored in a private `#value` field.
3. `SecretResolver { resolve(ref: SecretRef): Promise<Secret> }`; `CompositeSecretResolver` dispatches by scheme. File resolver trims one trailing newline and refuses world-readable files on POSIX (warn via return code `secret_file_permissions`, still resolve).
4. In `loadConfig`, add a post-validation walk: any key whose name matches `/(api[-_]?key|token|password|secret|credential)/i` must be a `SecretRef`; otherwise throw `config_invalid` with code detail `secret_inline`. Do not echo the value.
5. Document in `docs/secrets.md` how to use env, file, and Key Vault references.
**Tests to write:** `packages/config/src/secrets.test.ts`: each scheme parses; `JSON.stringify`, `String()`, `util.inspect` all yield `[REDACTED]`; inline secret rejected without echoing; env resolver missing var returns `secret_not_found`; file permission code.
**Acceptance Criteria:**

- [ ] No code path prints a revealed secret; verified by tests over stringify/inspect/log.
- [ ] Config containing a literal API key fails validation.
- [ ] `akv:` references parse and fail clearly until 12.4 lands.

---

## 20.4 `harness doctor` environment check

**Parent:** #20 Config and CLI core
**Task Description:** Add a diagnostic command with a pluggable check registry that other epics extend.
**Expected Inputs:** Loaded config, environment.
**Expected Output:** `packages/cli/src/commands/doctor.ts`, `packages/core/src/doctor.ts` (registry + `DoctorCheck` interface), initial checks, `docs/doctor.md`.
**Dependencies:** none beyond workspace.
**Items it depends on:** 20.1, 20.2, 20.3.
**Implementation guidance:**

1. `interface DoctorCheck { id: Code; title: string; run(ctx: DoctorContext): Promise<{ status: "ok"|"warn"|"fail"; code: Code; detail?: Id|Code }> }`. Registry is an array; export `registerDoctorCheck`.
2. Initial checks: `node_version` (>=22), `config_valid`, `secret_refs_resolvable` (resolve each referenced secret, report only ref names and status, never values), `data_dir_writable` (create/delete a temp file in the configured data dir).
3. Run checks sequentially with a per-check timeout (default 5s) so a hung check reports `fail` with code `check_timeout`.
4. Human output: table of id, status, code. `--json`: array. Exit code 1 if any `fail`, else 0 (warns do not fail).
5. Later tasks (7.x store connectivity, 6.x server reachability, 13.x Presidio, 19.x sandbox) register their checks; document the pattern.
**Tests to write:** `packages/core/src/doctor.test.ts` with fake checks (ok/warn/fail/timeout via fake timers); CLI test for exit codes and JSON shape; assert secret values never appear in output.
**Acceptance Criteria:**

- [ ] `harness doctor` returns non-zero when any check fails.
- [ ] Timeout handling verified.
- [ ] Output contains no secret values.

---

## 20.5 Sanctioned logger and lint ban on `console.*`

**Parent:** #20 Config and CLI core
**Task Description:** Provide the only allowed logger, whose API cannot accept free text, and enforce it by lint.
**Expected Inputs:** Log level and destination from config/CLI.
**Expected Output:** `packages/telemetry/src/logger.ts` (`Logger`, `createLogger`, `NoopLogger`), ESLint config updates (`no-restricted-imports` for `pino` outside `packages/telemetry`), docs section.
**Dependencies:** `pino`.
**Items it depends on:** 1.2.
**Implementation guidance:**

1. `type LogValue = Id | Code | number | boolean`; `type LogFields = Record<Code, LogValue>` (keys also Code-shaped). `interface Logger { debug/info/warn/error(event: Code, fields?: LogFields): void; child(bindings: LogFields): Logger }`. There is no message parameter by design.
2. `createLogger({ level, destination })` wraps `pino` writing JSON to stderr (default) or an injected stream. At runtime, validate fields with a Zod schema built from the types above and drop invalid fields, incrementing an internal `droppedFields` counter exposed for tests.
3. `NoopLogger` for libraries and tests. Packages receive a `Logger` via constructor injection, never import a global.
4. ESLint: forbid importing `pino` outside `packages/telemetry`; keep `no-console` as error everywhere (the CLI output module is the only exception, from 20.2).
5. Document that human-readable messages belong to CLI output, not logs.
**Tests to write:** `packages/telemetry/src/logger.test.ts`: valid fields emitted as JSON lines; a field with a free-text string is dropped and counted; level filtering; `child` merges bindings; lint test asserting `pino` import outside telemetry is flagged.
**Acceptance Criteria:**

- [ ] Logger API has no free-text parameter.
- [ ] Lint fails on `console.log` and on direct `pino` imports outside telemetry.
- [ ] Invalid fields are dropped, not emitted.
