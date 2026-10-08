# Epic #1: Foundation (monorepo and Azure Pipelines CI)

**Goal:** a repo where every later task has a place to live and an automated gate. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 1.1, 1.1.1, and 1.2 to 1.12, all size S.

---

## 1.1 Scaffold pnpm workspace with strict TypeScript and Vitest

**Parent:** #1 Foundation
**Task Description:** Create the empty monorepo skeleton so `pnpm install && pnpm test:unit` works, with the four Vitest projects (unit, integration, canary, replay) defined but only the unit project populated.
**Expected Inputs:** Repo containing `LICENSE`, the specs and `AGENTS.md` files, `CLAUDE.md`, `.gitignore`, `docs/engineering/layers.json`, and the dependency-free agent index generator `scripts/gen-agents-index.mjs` with its `node:test` suite `scripts/gen-agents-index.test.mjs`. Package layout in CONVENTIONS §1.
**Expected Output:** `package.json` (private, `engines.node >=22`, `packageManager` pnpm), `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `packages/schemas` with one exported `HARNESS_VERSION` constant and a test, `.nvmrc`, `.editorconfig`, edits to the existing `.gitignore` (add, never drop entries) and root `AGENTS.md`.
**Dependencies:** pnpm, Node 22, typescript, vitest, `@vitest/coverage-v8`.
**Items it depends on:** none.
**Implementation guidance:**
1. `pnpm-workspace.yaml` lists `packages/*`, `tools/*`. Do not create the other packages yet; each later task creates its package with a `package.json` (`name`, `version 0.0.0`, `type module`, `exports`, `scripts.build = tsc -b`).
2. `tsconfig.base.json` sets every flag listed in CONVENTIONS §2, `target ES2023`, `module NodeNext`, `moduleResolution NodeNext`, `declaration true`, `composite true`, `outDir dist`.
3. `packages/schemas/package.json` exports `./src/index.ts` during development via `exports: { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` and builds with `tsc -b`.
4. `vitest.workspace.ts` defines four projects named `unit`, `integration`, `canary`, `replay` using `include` globs from CONVENTIONS §6. The unit project excludes the other three patterns.
5. Root scripts: `build`, `lint` (placeholder echoing nothing until 1.2), `typecheck` (`tsc -b --noEmit`), `test:unit`, `test:integration`, `test:canary`, `test:replay` (each `vitest run --project <name> --passWithNoTests` except unit).
6. Create `packages/schemas/src/testing.ts` exporting `FakeClock` (`now()`, `advance(ms)`) and `SequentialIdGenerator` (deterministic fake ULID-shaped ids) with tests; later tasks extend it.
7. Root scripts for the agent index: `gen:agents` (`node scripts/gen-agents-index.mjs`) and `check:agents` (`node scripts/gen-agents-index.mjs --check && node --test scripts/gen-agents-index.test.mjs`). Keep the generator as dependency-free `.mjs`; porting it to TypeScript is out of scope. The Vitest `unit` project includes `*.test.ts` only (CONVENTIONS §6), so it must not collect `*.test.mjs`. CI wiring happens in 1.4.
8. Update root `AGENTS.md`: replace the "Current state" paragraph's no-workspace note (keep the `docs/progress.json` sentence), and switch the agent-index commands under Commands and "Done means" to `pnpm gen:agents` / `pnpm check:agents`. Then run `pnpm gen:agents` and commit any regenerated output.
**Tests to write:** `packages/schemas/src/index.test.ts` (constant exported); `packages/schemas/src/testing.test.ts` (fake clock advances; ids unique and 26 chars).
**Acceptance Criteria:**
- [ ] Fresh clone: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test:unit` exits 0.
- [ ] `pnpm test:integration`, `test:canary`, `test:replay` exit 0 with no tests.
- [ ] Lockfile committed; Node version pinned in `.nvmrc`.
- [ ] `pnpm check:agents` exits 0, and `pnpm test:unit` does not pick up `scripts/*.test.mjs`.
- [ ] Root `AGENTS.md` no longer says the workspace is missing, and refers to `pnpm gen:agents` / `pnpm check:agents`.

---

## 1.1.1 Yarn and mise toolchain: package management, scripts, and pinned tool versions

**Parent:** #1 Foundation
**Task Description:** Replace pnpm with Yarn (Berry, 4.x) for tracking, installing, building, and running the workspace, and pin the toolchain (Node, Corepack, Yarn) with mise so every machine, container, and CI agent uses identical versions. This is a follow-up to the completed task 1.1, so every later task builds on Yarn and mise.
**Expected Inputs:** The pnpm workspace from 1.1 and 1.2 (`pnpm-workspace.yaml`, `pnpm-lock.yaml`, root `package.json` scripts, `packageManager: pnpm@...`); the Dockerfile and compose files from 1.3 if 1.3 has merged first; every spec, `AGENTS.md`, `CONVENTIONS.md`, and README reference to pnpm.
**Expected Output:** `mise.toml`, `.yarnrc.yml`, `yarn.lock`, `yarn.config.cjs` (Yarn constraints), updated root `package.json` (`workspaces`, `packageManager: "yarn@4.x.y+sha512..."`, scripts including `build`, `start`, `clean`, `deps:check`), removal of `pnpm-workspace.yaml` and `pnpm-lock.yaml`, `.gitignore` entries for Yarn, `scripts/ci/toolchain.test.ts`, `docs/engineering/toolchain.md`, and every pnpm reference in specs, `AGENTS.md` files, `CONVENTIONS.md` (section 2), `CLAUDE.md`, and `README.md` rewritten to the Yarn equivalent.
**Dependencies:** Yarn 4.x (latest stable at implementation time; verify, and do not adopt the Yarn 6 preview), mise (pin the version used in CI), Corepack (installed explicitly through mise because Node 25 and later no longer bundle it).
**Items it depends on:** 1.1, 1.2.
**Implementation guidance:**
1. **mise (`mise.toml`).** `[tools]`: `node` pinned to an exact 22.x LTS version (it must satisfy `engines.node`), and `"npm:corepack"` pinned to an exact version. `[settings]`: enable Corepack for mise-managed Node (`node.corepack = true`; verify the setting name), and keep `experimental = false`. `[env]`: `NODE_OPTIONS` is not set here (scripts own their flags). Developers run `mise install` once, and `mise` activates the pinned tools in the repo. Document `mise trust` in `docs/engineering/toolchain.md`. Do not duplicate package scripts as mise tasks: `package.json` scripts are the single entry point (`yarn <script>`).
2. **Yarn version.** Pin it once in `package.json` `packageManager` with Corepack's integrity hash (run `corepack use yarn@4.x.y`). Corepack enforces it; nothing else pins Yarn. Do not commit `.yarn/releases`.
3. **`.yarnrc.yml`.** `nodeLinker: node-modules` (Plug'n'Play breaks parts of the ESLint, Vitest, and TypeScript tooling and the Docker deploy step; record this as a decision in the PR), `enableTelemetry: false`, `enableGlobalCache: true`, `defaultSemverRangePrefix: ""` (exact versions, matching the pinned versions already used), `npmMinimalAgeGate` set to at least 3 days with an override list kept empty by default (supply-chain guard for brand-new releases; verify the setting name and units in the pinned version), and `enableScripts: false` with an explicit `dependenciesMeta` allowlist for packages that need build scripts (for example native modules such as `better-sqlite3` later).
4. **Workspaces.** Root `package.json` gets `"workspaces": ["packages/*", "tools/*"]`; internal dependencies keep the `workspace:^` protocol. Remove `pnpm-workspace.yaml`. Generate `yarn.lock` from the current dependency versions with no upgrades (versions in the lockfile must match what `pnpm-lock.yaml` resolved; any difference is listed in the PR).
5. **Constraints (`yarn.config.cjs`).** Enforce with `yarn constraints`: every workspace has `"type": "module"`, `"license": "Apache-2.0"`, and `"private": true` until 21.6 decides what publishes; internal dependencies use `workspace:^`; a dependency used in several workspaces has one version everywhere (zod, typescript, vitest, `@types/node`); `@types/node` majors match the pinned Node major. `deps:check` runs `yarn constraints && yarn dedupe --check`, and `yarn lint` runs it.
6. **Scripts (root `package.json`).** Keep every existing script name (`lint`, `lint:fix`, `typecheck`, `test:unit`, `test:integration`, `test:canary`, `test:replay`, `gen:agents`, `check:agents`) so specs only change the runner prefix. Add `build` (`yarn workspaces foreach --all --topological --parallel run build`, verify flags), `start` (build, then run the CLI: `yarn workspace @harness/cli start`, which runs `node dist/bin.js`), `clean` (remove `dist`, `coverage`, `*.tsbuildinfo`), and `deps:check`. Package-level scripts stay in each workspace's `package.json`.
7. **Command mapping (apply everywhere).** `pnpm install --frozen-lockfile` becomes `yarn install --immutable`; `pnpm <script>` becomes `yarn <script>`; `pnpm -r build` becomes `yarn build`; `pnpm --filter <pkg> <cmd>` becomes `yarn workspace <pkg> <cmd>`; `pnpm dlx` becomes `yarn dlx`; `pnpm audit` becomes `yarn npm audit --all --recursive`; `pnpm licenses list --json` becomes a Yarn-compatible license report (verify: `yarn info --all --recursive --json` fields, or a license plugin) and task 1.7 is updated accordingly; `pnpm deploy --filter @harness/cli --prod /out` becomes a production install of the CLI workspace (`yarn workspaces focus @harness/cli --production` in a pruned copy; verify the plugin is built in for the pinned Yarn); `pnpm changeset` and `pnpm -r publish` (21.6) become `yarn changeset` and `yarn workspaces foreach --all --no-private npm publish`.
8. **Containers.** If 1.3 has merged, update the Dockerfile build stage to install with Yarn (`corepack enable` honoring `packageManager`, `yarn install --immutable`, `yarn build`, then the production focus step from step 7) and keep the runtime stage unchanged. Otherwise add the equivalent guidance to 1.3's spec so it lands with Yarn.
9. **Spec and doc updates (same PR).** Rewrite every pnpm reference in `docs/engineering/**`, epic specs, `AGENTS.md` and `TASKS.md` files, `CLAUDE.md`, and `README.md` using step 7; update CONVENTIONS section 2 (tooling: Node via mise, Yarn 4 via Corepack, `nodeLinker: node-modules`) and the Azure Pipelines guidance in 1.4 (install mise at a pinned version, `mise install`, cache the Yarn global cache keyed by `yarn.lock` and `mise.toml`, `yarn install --immutable`). Run `yarn gen:agents` and commit the regenerated blocks.
10. **CI and dependency updates.** 1.10's Dependabot config keeps the `npm` ecosystem (it supports Yarn Berry lockfiles; verify) and adds an ignore rule so Dependabot never changes `packageManager` without review.
**Tests to write:** `scripts/ci/toolchain.test.ts` (unit): `mise.toml` pins an exact Node 22.x version that satisfies `engines.node`; `packageManager` is `yarn@4.x.y` with an integrity hash; `.yarnrc.yml` has `nodeLinker: node-modules`, `enableTelemetry: false`, and an age gate; `pnpm-lock.yaml` and `pnpm-workspace.yaml` do not exist; every workspace satisfies the constraints (run `yarn constraints` and assert exit code 0); a repository scan finds no `pnpm` references outside an explicit allowlist (historical PR notes only).
**Acceptance Criteria:**
- [ ] Fresh clone: `mise install && yarn install --immutable && yarn lint && yarn typecheck && yarn test:unit && yarn build` exits 0, and `yarn start --version` prints the version.
- [ ] Node, Corepack, and Yarn versions are pinned in exactly one place each, and the toolchain test proves they agree.
- [ ] `yarn constraints` and `yarn dedupe --check` pass and run as part of `yarn lint`.
- [ ] No pnpm files or references remain in the repository, specs, or docs (scan test passes); `yarn check:agents` passes.

---

## 1.2 Strict ESLint and Prettier configuration with zero-warning enforcement

**Parent:** #1 Foundation
**Task Description:** Add a strict, type-aware lint configuration that enforces CONVENTIONS section 3, the package boundaries, and the security-relevant bans, with no warning level: every rule either fails the build or is off.
**Expected Inputs:** Workspace from 1.1, `docs/engineering/layers.json`.
**Expected Output:** `eslint.config.js` (flat, type-aware), `tools/eslint-plugin-harness` (rule registry wired as plugin `harness`), `.prettierrc.json`, `.prettierignore`, per-package `tsconfig.json` template, root scripts `lint` (all linters, zero warnings) and `lint:fix`, `docs/engineering/linting.md` (rule rationale, how to suppress, how to propose a rule change), `tools/eslint-plugin-harness/src/config.test.ts`.
**Dependencies:** `eslint` (flat config), `typescript-eslint`, `eslint-plugin-import-x`, `eslint-plugin-n`, `eslint-plugin-promise`, `eslint-plugin-regexp`, `eslint-plugin-unicorn`, `@eslint-community/eslint-plugin-eslint-comments`, `@vitest/eslint-plugin`, `eslint-plugin-jsdoc`, `eslint-config-prettier`, `prettier` (verify flat-config support for each and check licenses against the 1.7 allowlist).
**Items it depends on:** 1.1.
**Implementation guidance:**
1. Severity policy: every rule is `error` or `off`; the config contains no `warn` (a test enforces it). `linterOptions.reportUnusedDisableDirectives: "error"`. The `lint` script runs `eslint . --max-warnings 0` so a future `warn` still fails.
2. TypeScript files: `tseslint.configs.strictTypeChecked` and `tseslint.configs.stylisticTypeChecked` with `parserOptions.projectService: true`, plus these explicitly as errors: `no-explicit-any`, `no-non-null-assertion`, `no-floating-promises`, `no-misused-promises`, `await-thenable`, `require-await`, `return-await` (`in-try-catch`), `only-throw-error`, `no-unnecessary-condition`, `strict-boolean-expressions` (no implicit nullable or number coercion), `switch-exhaustiveness-check`, `consistent-type-imports`, `consistent-type-exports`, `explicit-module-boundary-types`, `prefer-readonly`, `no-shadow`, `no-unused-vars` (args after used, `_` prefix ignored), `consistent-type-assertions` with `assertionStyle: "never"` (CONVENTIONS 3.1; an adapter that truly needs a cast uses a disable comment with a reason), `ban-ts-comment` (only `@ts-expect-error` with a description), `no-restricted-types` for `object` and `Function`.
3. Core rules (all JS and TS files): `eqeqeq`, `no-console`, `curly: all`, `no-eval`, `no-implied-eval`, `no-new-func`, `no-param-reassign` (with props), `prefer-const`, `no-var`, `object-shorthand`, `no-nested-ternary`, `no-restricted-syntax` banning TypeScript `enum` declarations (use string-literal unions), `export default` (named exports only), `for...in`, and labeled statements; size limits `complexity: 15`, `max-depth: 4`, `max-params: 4` (use an options object), `max-lines-per-function: 80` and `max-lines: 400` (both skipping blank lines and comments).
4. Plugin rules (errors): `import-x/no-cycle`, `no-extraneous-dependencies`, `no-duplicates`, `no-self-import`, `no-useless-path-segments`, `no-relative-packages` (cross-package imports use `@harness/*` names), `extensions` requiring `.js` in relative imports; `n/prefer-node-protocol`, `n/no-deprecated-api`, `n/no-process-exit`; `promise/param-names`, `promise/no-multiple-resolved`; `regexp` recommended plus `regexp/no-super-linear-backtracking` and `regexp/no-misleading-capturing-group` (ReDoS, which matters for PII detectors and policy matchers); curated `unicorn` rules (`throw-new-error`, `error-message`, `prefer-type-error`, `no-instanceof-array`, `prefer-number-properties`, `prefer-string-replace-all`, `no-useless-spread`, `no-abusive-eslint-disable`, `no-document-cookie`); `jsdoc/require-jsdoc` for exported functions, classes, interfaces, and type aliases (`publicOnly`), `jsdoc/no-types`, and TSDoc tag names allowed by `jsdoc/check-tag-names`.
5. Suppressions: `eslint-comments/require-description` (format `-- <reason>`), `no-unlimited-disable`, `no-unused-disable`, `disable-enable-pair`, and `no-restricted-disable` for rules that may never be disabled inline: `harness/*`, `no-console`, `no-eval`, `no-implied-eval`, `no-new-func`, `@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-floating-promises`, `regexp/no-super-linear-backtracking`, and the boundary rules from step 7. Changing those requires a config change reviewed in a PR.
6. Tests (`**/*.test.ts` and the other Vitest patterns): `@vitest/eslint-plugin` recommended plus `no-focused-tests`, `no-disabled-tests` (conditional skips via `skipIf` stay allowed for `LIVE` tests), `expect-expect`, `no-conditional-expect`, `valid-title`. Size limits and `jsdoc` rules are off in tests; type safety rules stay on.
7. Boundaries: the import-direction rule reads `docs/engineering/layers.json` (load the JSON; do not copy the table) so later packages only add a row there. Package-scoped `no-restricted-imports`: `pino` and `@opentelemetry/sdk-*` only in `packages/telemetry`; `node:child_process` only in `packages/sandbox` and `scripts`; `ajv` and `yaml` only through the helpers from 1.12. Browser code (`packages/app-telemetry`, `packages/approval-app`, `packages/host/src/web`, `packages/control-plane/app`): `no-restricted-globals` for `process`, `require`, `Buffer`, `no-restricted-imports` for `node:*`, and `no-restricted-properties` for `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`.
8. Untyped parsing: `no-restricted-properties` bans `JSON.parse` everywhere except the 1.12 helper module and tests; data enters through `parseJson(schema, text)` (CONVENTIONS 3.10).
9. Formatting is Prettier's job (`printWidth: 100`, trailing commas, double quotes); `eslint-config-prettier` goes last. Markdown is excluded from Prettier (1.11 lints it).
10. Ignores: `dist`, `coverage`, `node_modules`, `docs/api`, and generated files (`*.generated.*`); generated files are checked by their own `--check` scripts. Existing `scripts/*.mjs` files are linted with the JavaScript rules and must pass.
11. `docs/engineering/linting.md` explains each rule group, the suppression format, and that relaxing a rule needs a PR that states why (root `AGENTS.md`).
**Tests to write:** `tools/eslint-plugin-harness/src/config.test.ts` using the ESLint Node API against fixture strings: one violation per rule group above is flagged (`any`, non-null assertion, floating promise, `console.log`, `enum`, default export, deep nesting, ReDoS regex, raw `JSON.parse`, `innerHTML` in browser code, forbidden cross-package import, relative cross-package import, `.only` in a test); a clean file passes; the resolved config contains no `warn` severity; a disable comment without a reason is flagged; an inline disable of a restricted rule is flagged; an unused disable directive is flagged.
**Acceptance Criteria:**
- [ ] `pnpm lint` exits 0 on the repository with zero errors and zero warnings.
- [ ] Every fixture violation fails, proven by the test.
- [ ] The config has no warning-level rules; suppressions require a reason; restricted rules cannot be disabled inline.
- [ ] The import-direction rule rejects `@harness/telemetry` importing `@harness/store`.

---

## 1.3 Non-root Dockerfile and compose skeleton

**Parent:** #1 Foundation
**Task Description:** Provide a hardened base image build and a compose file that starts a placeholder `harness` service with a healthcheck.
**Expected Inputs:** Workspace; a placeholder `packages/cli` with a `bin` printing the version.
**Expected Output:** `Dockerfile` (multi-stage), `.dockerignore`, `infra/compose/docker-compose.yml`, minimal `packages/cli` (`src/bin.ts`, `package.json` with `bin.harness`).
**Dependencies:** Docker, `node:22-slim` base image.
**Items it depends on:** 1.1, 1.1.1.
**Implementation guidance:**
1. Build stage: `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm deploy --filter @harness/cli --prod /out` (verify `pnpm deploy` behavior with the workspace).
2. Runtime stage: copy `/out`, create user uid/gid 10001, `USER 10001`, `WORKDIR /app`, `ENTRYPOINT ["node","dist/bin.js"]`, `HEALTHCHECK` running `node dist/bin.js --version`.
3. Never copy `.git`, `node_modules`, test files (`.dockerignore`).
4. Compose service `harness` with `read_only: true`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, healthcheck matching the image.
5. `packages/cli/src/bin.ts` prints `HARNESS_VERSION` and exits 0 (real CLI arrives in epic 20).
**Tests to write:** `scripts/ci/docker-image.int.test.ts`: builds the image, asserts `docker run --rm <img> id -u` is not 0, `--version` prints a semver, container fs is read-only under compose.
**Acceptance Criteria:**
- [ ] `docker compose -f infra/compose/docker-compose.yml up --wait` reaches healthy.
- [ ] Image runs as a non-root user; root filesystem read-only works.
- [ ] Image build is reproducible from a clean checkout in CI.

---

## 1.4 azure-pipelines.yml with lint, typecheck, unit stages and result publishing

**Parent:** #1 Foundation
**Task Description:** Add the first Azure Pipelines definition: PR-triggered `static` and `unit` stages with JUnit and coverage publishing and package-manager caching.
**Expected Inputs:** Working scripts from 1.1/1.2.
**Expected Output:** `azure-pipelines.yml`, `pipelines/templates/node-setup.yml`, `scripts/ci/verify-pipeline.test.ts`.
**Dependencies:** Azure DevOps project with the GitHub service connection and the Azure Pipelines GitHub app installed (manual, documented in `docs/maintainers/azure-setup.md`); `yaml` npm package for the test.
**Items it depends on:** 1.1, 1.2, 1.1.1.
**Implementation guidance:**
1. `trigger: [main]`, `pr: [main]`, `pool: { vmImage: ubuntu-latest }`.
2. Template `node-setup.yml`: `NodeTool@0` (22.x), `corepack enable`, `Cache@2` keyed on `pnpm-lock.yaml`, `pnpm install --frozen-lockfile`.
3. Stage `static`: steps `pnpm lint` (every linter from 1.2 and 1.11, zero warnings), typecheck, and `pnpm check:agents` (agent index drift and broken links, from 1.1). A lint failure fails the stage; there is no allow-failure path. Stage `unit`: `pnpm test:unit -- --reporter=junit --outputFile=reports/junit.xml --coverage`, then `PublishTestResults@2` (`testResultsFormat: JUnit`, `condition: succeededOrFailed()`) and `PublishCodeCoverageResults@2` (Cobertura) (verify task versions).
4. Stage names must be exactly the ones in CONVENTIONS §7; later tasks add steps, not rename stages.
5. Document the exact check names that branch protection will require (used by 1.9).
**Tests to write:** `scripts/ci/verify-pipeline.test.ts` parses the YAML and asserts: PR trigger present, stages `static` and `unit` exist in order, `static` runs `pnpm check:agents`, `PublishTestResults@2` has `condition` containing `succeededOrFailed`, no secret-looking literals.
**Acceptance Criteria:**
- [ ] A PR with a failing unit test shows a failing Azure check and published results.
- [ ] A passing PR publishes JUnit and coverage.
- [ ] Cache hit visible on the second run.

---

## 1.5 NOTICE file and SPDX header check

**Parent:** #1 Foundation
**Task Description:** Add the Apache-2.0 `NOTICE` file and a CI script failing any source file lacking the SPDX header.
**Expected Inputs:** Repo tree; header convention from CONVENTIONS §3.7.
**Expected Output:** `NOTICE`, `scripts/check-spdx.ts`, `pnpm check:spdx` script, `static` stage step.
**Dependencies:** `tsx` (or node's type stripping) to run scripts; `fast-glob`.
**Items it depends on:** 1.1, 1.4, 1.1.1.
**Implementation guidance:**
1. `NOTICE` text: project name, `Copyright <YEAR> <COPYRIGHT HOLDER>` where the holder is a placeholder the maintainer replaces (do not invent a legal name; leave `<COPYRIGHT HOLDER>` and open a follow-up note in the PR).
2. Script globs `**/*.{ts,tsx,js,mjs,cjs,sh,yml,yaml}` excluding `node_modules`, `dist`, `coverage`, `**/__golden__/**`, `pnpm-lock.yaml`.
3. For `.ts/.js/.mjs/.tsx`: first line (or second if first is a shebang) must equal `// SPDX-License-Identifier: Apache-2.0`. For `.sh/.yml/.yaml`: `# SPDX-License-Identifier: Apache-2.0`.
4. Provide `--fix` that prepends the header; CI runs without `--fix`.
5. Export the checking function so it can be unit-tested without the CLI.
**Tests to write:** `scripts/check-spdx.test.ts` with temp-dir fixtures: missing header fails with the file path listed; shebang handling; excluded directories ignored; `--fix` produces a passing tree.
**Acceptance Criteria:**
- [ ] CI fails when a new `.ts` file lacks the header.
- [ ] `--fix` repairs it and a second run passes.
- [ ] `NOTICE` committed with the placeholder flagged in the PR.

---

## 1.6 DCO sign-off check

**Parent:** #1 Foundation
**Task Description:** Add a CI script that fails a PR if any non-merge commit lacks a valid `Signed-off-by` trailer.
**Expected Inputs:** Git history of the PR branch relative to the target branch.
**Expected Output:** `scripts/check-dco.ts`, `pnpm check:dco`, `static` stage step (PR builds only), `CONTRIBUTING` snippet in `docs/contributing-dco.md`.
**Dependencies:** git; `execa` or `node:child_process`.
**Items it depends on:** 1.1, 1.4, 1.1.1.
**Implementation guidance:**
1. Range: `git log --no-merges --format=%H%x1f%an%x1f%ae%x1f%B%x1e origin/${TARGET_BRANCH}..HEAD`; Azure sets `System.PullRequest.TargetBranch` (pass via env). Ensure the checkout step uses `fetchDepth: 0`.
2. Valid trailer regex: `^Signed-off-by: .+ <[^<>@\s]+@[^<>\s]+>$` (multiline). Require at least one valid trailer per commit; recommend (warn, not fail) that it match the author email.
3. Skip commits authored by `dependabot[bot]` only if configured in `config/dco-exemptions.json` (default empty). The exemptions file has a Zod schema next to the script and is read with `parseJson` (CONVENTIONS 3.10).
4. Output lists offending short SHAs and the fix command (`git rebase --signoff`).
**Tests to write:** `scripts/check-dco.test.ts` creating temp repos with `git init`: signed commit passes; unsigned fails; merge commit ignored; malformed trailer fails; exemption works.
**Acceptance Criteria:**
- [ ] Unsigned commit on a PR fails the check with actionable output.
- [ ] Signed commits pass; merge commits ignored.
- [ ] Documented in contributor docs.

---

## 1.7 License scan

**Parent:** #1 Foundation
**Task Description:** Fail CI when a dependency's license is outside the allowlist (denying GPL/AGPL and similar).
**Expected Inputs:** Installed workspace dependencies; policy file.
**Expected Output:** `config/license-policy.json`, `scripts/check-licenses.ts`, `pnpm check:licenses`, `static` stage step.
**Dependencies:** `pnpm licenses list --json` (verify output shape), `spdx-expression-parse`, `spdx-satisfies`.
**Items it depends on:** 1.1, 1.4, 1.1.1.
**Implementation guidance:**
1. Policy JSON: `allow` (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, Unlicense, CC0-1.0, Python-2.0), `deny` (any `GPL-*`, `AGPL-*`, `LGPL-*`, `SSPL-*`, `BUSL-*`, `CC-BY-NC*`), `exceptions` array of `{ package, version?, reason, expires }`. `config/license-policy.json` is defined by a Zod schema (`LicensePolicy`) and read with `parseJson` (CONVENTIONS 3.10).
2. Evaluate each package's SPDX expression: `A OR B` passes if any alternative is allowed; `A AND B` requires all allowed; unknown or `UNLICENSED` fails unless excepted.
3. Fail on expired exceptions. Print a table of violations with package, version, license.
4. Separate the pure evaluator (`evaluateLicenses(packages, policy)`) from the pnpm invocation for testing.
**Tests to write:** `scripts/check-licenses.test.ts`: table-driven SPDX cases (`MIT`, `MIT OR GPL-3.0`, `GPL-3.0`, `MIT AND GPL-3.0`, `UNLICENSED`, unknown string); exception honored; expired exception fails.
**Acceptance Criteria:**
- [ ] Adding a GPL-licensed dev dependency fails CI.
- [ ] `MIT OR GPL-3.0` dual license passes.
- [ ] Violations list package, version, and license.

---

## 1.8 Integration-stage skeleton

**Parent:** #1 Foundation
**Task Description:** Add the `integration` pipeline stage that brings up compose services, runs integration tests, always collects logs, and always tears down.
**Expected Inputs:** Compose skeleton (1.3), pipeline (1.4).
**Expected Output:** `infra/compose/docker-compose.test.yml`, `integration` stage in `azure-pipelines.yml`, `test/smoke.int.test.ts`, `scripts/ci/compose-wait.sh`.
**Dependencies:** Docker on the Microsoft-hosted agent, docker compose v2.
**Items it depends on:** 1.3, 1.4, 1.1.1.
**Implementation guidance:**
1. Test compose file extends the base file and adds a `smoke` check only; later epics add `postgres`, `otel-collector`, `presidio`, `sample-mcp-server`, `kusto-emulator` services here.
2. Stage steps: `docker compose -f infra/compose/docker-compose.test.yml up -d --wait`; `pnpm test:integration` with JUnit output; `PublishTestResults@2`; on failure, `docker compose logs --no-color > $(Build.ArtifactStagingDirectory)/compose.log` and `PublishBuildArtifacts@1`; final step `docker compose down -v` with `condition: always()`.
3. `smoke.int.test.ts` asserts the `harness` service healthcheck status is `healthy` via `docker inspect`.
4. Stage `dependsOn: unit`.
**Tests to write:** `test/smoke.int.test.ts` as above; `scripts/ci/verify-pipeline.test.ts` extended to assert the integration stage has an `always()` teardown step.
**Acceptance Criteria:**
- [ ] Integration stage passes on a clean PR.
- [ ] A forced failure uploads `compose.log`.
- [ ] Containers are removed even when tests fail.

---

## 1.9 Branch protection, CODEOWNERS, PR and issue templates

**Parent:** #1 Foundation
**Task Description:** Codify repo governance: templates in the repo and a script plus doc that apply branch protection requiring the Azure and DCO checks.
**Expected Inputs:** Check names from 1.4; this task spec format (for the issue template).
**Expected Output:** `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/task.yml`, `scripts/github/apply-branch-protection.sh` (supports `--dry-run`), `docs/maintainers/branch-protection.md`.
**Dependencies:** `gh` CLI (documented, run by a maintainer), `yaml` for tests.
**Items it depends on:** 1.4, 1.6, 1.1.1.
**Implementation guidance:**
1. PR template checklist mirrors CONVENTIONS §8 and asks for the task ID, including the item "`pnpm lint` passes with zero errors and warnings, and any new suppression has a written reason".
2. Issue template `task.yml` (GitHub issue forms) has inputs matching the task spec fields (Parent, Description, Inputs, Output, Tests, Acceptance, Dependencies, Depends on).
3. Script calls `gh api -X PUT repos/{owner}/{repo}/branches/main/protection` with required status checks (the exact Azure check name(s) from 1.4 and the DCO check), required PR review count 1, no force pushes, conversation resolution required. `--dry-run` prints the JSON payload without calling.
4. CODEOWNERS: default owner is the repo owner; add path owners for `packages/telemetry/`, `packages/pii/`, `infra/collector/` (security-sensitive).
**Tests to write:** `scripts/github/apply-branch-protection.test.ts` (dry-run payload snapshot); YAML parse test for `task.yml` verifying required fields.
**Acceptance Criteria:**
- [ ] Dry run prints a payload requiring the named checks.
- [ ] Templates render in GitHub (maintainer confirms once).
- [ ] CODEOWNERS covers the security-sensitive paths.

---

## 1.10 Dependency update automation

**Parent:** #1 Foundation
**Task Description:** Configure automated dependency and base-image update PRs with sensible grouping and limits.
**Expected Inputs:** Workspace and Dockerfile.
**Expected Output:** `.github/dependabot.yml`, `docs/maintainers/dependency-policy.md`.
**Dependencies:** GitHub Dependabot.
**Items it depends on:** 1.1, 1.3, 1.1.1.
**Implementation guidance:**
1. Ecosystems: `npm` (covers pnpm workspaces; verify) at `/`, `docker` at `/`, weekly schedule.
2. Group minor and patch updates (`groups`), `open-pull-requests-limit: 5`.
3. Ignore semver-major updates for `zod` and `@modelcontextprotocol/*` until a maintainer approves (these gate cross-package compatibility); document how to lift the ignore.
4. Commit message prefix `deps`; add the `dependencies` label; ensure Dependabot commits satisfy DCO (use the exemption file from 1.6 if needed).
**Tests to write:** `scripts/ci/dependabot.test.ts` parsing the YAML and asserting ecosystems, schedule, and the ignore rules.
**Acceptance Criteria:**
- [ ] Config is valid (GitHub reports no errors).
- [ ] Major bumps for the pinned packages are ignored.
- [ ] Policy documented.

---

## 1.11 Linters beyond TypeScript: Markdown, YAML, shell, Dockerfiles, spelling

**Parent:** #1 Foundation
**Task Description:** Lint every non-TypeScript file type the repository holds, under the same zero-error rule, and fix existing violations.
**Expected Inputs:** Repository files: specs and docs (Markdown), compose, pipeline, and collector configs (YAML), scripts (shell), Dockerfiles.
**Expected Output:** `.markdownlint-cli2.yaml`, YAML linting through `eslint-plugin-yml` in the ESLint run, `.shellcheckrc`, `.hadolint.yaml`, `cspell.json` with `docs/engineering/project-words.txt`, `.editorconfig` checks, root scripts `lint:md`, `lint:yaml`, `lint:sh`, `lint:docker`, `lint:spell` included in `pnpm lint`, fixes to existing files.
**Dependencies:** `markdownlint-cli2`, `eslint-plugin-yml`, ShellCheck, hadolint (pinned container image or binary), `cspell`, `editorconfig-checker` (verify versions and licenses against 1.7).
**Items it depends on:** 1.2, 1.4, 1.1.1.
**Implementation guidance:**
1. Markdown: start from markdownlint defaults; disable only `MD013` (line length; specs use long lines) and allow inline HTML for the comment markers the repo uses (`<!-- BEGIN GENERATED ... -->`, `<!-- test:run -->`, `<!-- claims:allow -->`). Require fenced code blocks to declare a language. Fix existing docs and specs without changing their meaning.
2. YAML: `eslint-plugin-yml` recommended rules plus consistent indentation and no duplicate keys, covering compose, pipelines, collector configs, and `.github`.
3. Shell: ShellCheck at severity `style` on every `*.sh`; scripts start with `set -euo pipefail`.
4. Dockerfiles: hadolint with no ignored rules by default (any ignore needs a reason comment in `.hadolint.yaml`), pinned image digests required.
5. Spelling: cspell over Markdown, code comments, and string literals in `packages/*/src`, with a reviewed project word list. New words are added deliberately in the PR that introduces them.
6. `pnpm lint` runs every linter and fails if a required binary is missing (no silent skips). Locally, `LINT_SKIP_CONTAINERS=1` may skip container-based linters with a printed warning; CI never sets it.
**Tests to write:** fixture tests per linter (a known violation fails, a clean file passes); a test that `pnpm lint` fails when a required linter binary is absent; the repository passes every linter.
**Acceptance Criteria:**
- [ ] Every Markdown, YAML, shell, Dockerfile, and spelling check passes on the repository with zero errors.
- [ ] Each linter is part of `pnpm lint` and of the `static` stage.
- [ ] Missing linters fail instead of being skipped in CI.

---

## 1.12 Schema-first contract helpers

**Parent:** #1 Foundation
**Task Description:** Provide the helpers that make Zod the single source of truth for every data contract: typed parsing of JSON and YAML, and one wrapper for validating against external JSON Schema documents.
**Expected Inputs:** Zod schemas, untrusted text, external JSON Schema documents (for example MCP tool input schemas).
**Expected Output:** `packages/schemas/src/parse.ts` (`parseJson`, `parseYaml`, `safeParseJson`), `packages/schemas/src/json-schema.ts` (`compileJsonSchema`), `ContractError` (`contract_invalid`, issue paths only), CONVENTIONS rule 3.10, lint wiring from 1.2 step 8.
**Dependencies:** `zod` (major per CONVENTIONS section 2), `yaml`, `ajv` with JSON Schema 2020-12 support and `ajv-formats` (verify).
**Items it depends on:** 1.1, 1.2, 1.1.1.
**Implementation guidance:**
1. `parseJson(schema, text, { maxBytes })` and `parseYaml(schema, text, { maxBytes })` enforce a size limit before parsing, parse, then validate with the Zod schema and return the inferred type. Failures throw `ContractError` with issue paths and codes only, never the received values.
2. `compileJsonSchema(jsonSchema, { maxRefDepth, maxBytes })` compiles an **external** JSON Schema (draft 2020-12) once with `ajv`, bounds `$ref` resolution and schema size, disallows remote `$ref` fetching, and returns a validator with the same error shape. It exists only for schemas the harness does not own (MCP tool `inputSchema` and `outputSchema`); harness-owned contracts never use it.
3. Allow `yaml` and `ajv` as dependencies of `@harness/schemas` (update `packages/schemas/AGENTS.md`); `zod` stays the only schema library for harness-owned contracts.
4. Types for contracts come from `z.infer` of the schema; a lint test (or `no-restricted-syntax` selector) flags hand-written interfaces that duplicate a schema name exported next to them.
**Tests to write:** valid and invalid JSON and YAML; size limits; errors contain no values (canary); external schema with `$ref` depth bound, remote `$ref` rejected, 2020-12 keywords supported; inferred types checked with `expectTypeOf`.
**Acceptance Criteria:**
- [ ] All JSON and YAML entering the system goes through `parseJson`/`parseYaml` (raw `JSON.parse` is a lint error).
- [ ] External JSON Schemas are validated through one bounded wrapper.
- [ ] Contract errors never contain submitted values.

