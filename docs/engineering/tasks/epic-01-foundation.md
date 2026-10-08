# Epic #1: Foundation (monorepo and Azure Pipelines CI)

**Goal:** a repo where every later task has a place to live and an automated gate. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 1.1, 1.1.1, and 1.2 to 1.12, all size S.

---

## 1.1 Scaffold Yarn workspace with strict TypeScript and Vitest

**Parent:** #1 Foundation
**Task Description:** Create the empty monorepo skeleton so `yarn install && yarn test:unit` works, with the four Vitest projects (unit, integration, canary, replay) defined but only the unit project populated.
**Expected Inputs:** Repo containing `LICENSE`, the specs and `AGENTS.md` files, `CLAUDE.md`, `.gitignore`, `docs/engineering/layers.json`, and the dependency-free agent index generator `scripts/gen-agents-index.mjs` with its `node:test` suite `scripts/gen-agents-index.test.mjs`. Package layout in CONVENTIONS §1.
**Expected Output:** `package.json` (private, `engines.node >=22`, `packageManager`, and workspaces), `tsconfig.base.json`, `vitest.config.ts`, `packages/schemas` with one exported `HARNESS_VERSION` constant and a test, `.editorconfig`, edits to the existing `.gitignore` (add, never drop entries) and root `AGENTS.md`.
**Dependencies:** yarn, Node 22, typescript, vitest, `@vitest/coverage-v8`.
**Items it depends on:** none.
**Implementation guidance:**
1. `package.json` declares workspaces `packages/*` and `tools/*`. Do not create the other packages yet; each later task creates its package with a `package.json` (`name`, `version 0.0.0`, `type module`, `exports`, `scripts.build = tsc -b`).
2. `tsconfig.base.json` sets every flag listed in CONVENTIONS §2, `target ES2023`, `module NodeNext`, `moduleResolution NodeNext`, `declaration true`, `composite true`, `outDir dist`.
3. `packages/schemas/package.json` exports `./src/index.ts` during development via `exports: { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }` and builds with `tsc -b`.
4. `vitest.config.ts` defines four projects named `unit`, `integration`, `canary`, `replay` using `include` globs from CONVENTIONS §6. The unit project excludes the other three patterns.
5. Root scripts: `build`, `lint` (placeholder echoing nothing until 1.2), `typecheck` (`tsc -b --noEmit`), `test:unit`, `test:integration`, `test:canary`, `test:replay` (each `vitest run --project <name> --passWithNoTests` except unit).
6. Create `packages/schemas/src/testing.ts` exporting `FakeClock` (`now()`, `advance(ms)`) and `SequentialIdGenerator` (deterministic fake ULID-shaped ids) with tests; later tasks extend it.
7. Root scripts for the agent index: `gen:agents` (`node scripts/gen-agents-index.mjs`) and `check:agents` (`node scripts/gen-agents-index.mjs --check && node --test scripts/gen-agents-index.test.mjs`). Keep the generator as dependency-free `.mjs`; porting it to TypeScript is out of scope. The Vitest `unit` project includes `*.test.ts` only (CONVENTIONS §6), so it must not collect `*.test.mjs`. CI wiring happens in 1.4.
8. Update root `AGENTS.md`: replace the "Current state" paragraph's no-workspace note (keep the `docs/progress.json` sentence), and switch the agent-index commands under Commands and "Done means" to `yarn gen:agents` / `yarn check:agents`. Then run `yarn gen:agents` and commit any regenerated output.
**Tests to write:** `packages/schemas/src/index.test.ts` (constant exported); `packages/schemas/src/testing.test.ts` (fake clock advances; ids unique and 26 chars).
**Acceptance Criteria:**
- [ ] Fresh clone: `yarn install --immutable && yarn typecheck && yarn test:unit` exits 0.
- [ ] `yarn test:integration`, `test:canary`, `test:replay` exit 0 with no tests.
- [ ] Lockfile committed; the active follow-up toolchain configuration supplies an exact Node pin.
- [ ] `yarn check:agents` exits 0, and `yarn test:unit` does not pick up `scripts/*.test.mjs`.
- [ ] Root `AGENTS.md` no longer says the workspace is missing, and refers to `yarn gen:agents` / `yarn check:agents`.

---

## 1.1.1 Yarn and mise toolchain: package management, scripts, and pinned tool versions

**Parent:** #1 Foundation
**Task Description:** Standardize package management on Yarn 4 and pin Node.js, Corepack, Yarn, and mise so every machine, container, and CI agent uses the same toolchain.
**Expected Inputs:** The Yarn workspace from 1.1 and 1.2, the Dockerfile and compose files from 1.3, and the existing toolchain references in specs, `AGENTS.md` files, conventions, and README.
**Expected Output:** `mise.toml`, `.yarnrc.yml`, `yarn.lock`, `yarn.config.cjs` (Yarn constraints), root `package.json` workspaces and integrity-pinned `packageManager`, scripts including `build`, `start`, `clean`, and `deps:check`, removal of obsolete package-manager files, Yarn ignore entries, `scripts/ci/toolchain.test.ts`, `docs/engineering/toolchain.md`, updated tooling references throughout the repository, and regenerated agent indexes.
**Dependencies:** Yarn 4.18.1 (latest stable verified for this task; not the Yarn 6 preview), mise 2026.10.4, Node.js 22.23.3, and Corepack 0.36.0.
**Items it depends on:** 1.1, 1.2.
**Implementation guidance:**
1. **mise (`mise.toml`).** Pin Node 22.23.3 and `"npm:corepack"` 0.36.0 under `[tools]`; enable `node.corepack` and set `experimental = false`. Do not set `NODE_OPTIONS` or duplicate package scripts as mise tasks. Developers run `mise trust` and `mise install`; document these commands in `docs/engineering/toolchain.md`.
2. **Yarn version.** Pin Yarn 4.18.1 once in the root `packageManager` field using Corepack's integrity hash. Corepack enforces it; do not add another Yarn version pin or commit `.yarn/releases`.
3. **`.yarnrc.yml`.** Use `nodeLinker: node-modules`, `enableTelemetry: false`, `enableGlobalCache: true`, `defaultSemverRangePrefix: ""`, `npmMinimalAgeGate: 3d`, an empty `npmPreapprovedPackages` list, and `enableScripts: false`. Keep the root `dependenciesMeta` build-script allowlist explicit; esbuild is the only package currently allowed to run its build script. Yarn 4.18.1 verifies the age-gate duration syntax and Corepack behavior.
4. **Workspaces.** Root `package.json` declares `["packages/*", "tools/*"]`; all internal dependencies use `workspace:^`. The committed Yarn lockfile preserves the versions resolved by the previous lockfile unless a difference is recorded in the PR.
5. **Constraints (`yarn.config.cjs`).** Require every workspace to have `"type": "module"`, `"license": "Apache-2.0"`, and `"private": true` until 21.6 decides what publishes. Require internal dependencies to use `workspace:^`, align shared dependency versions (including zod, typescript, vitest, and `@types/node`), and require the `@types/node` major to match the Node major in the manifest. `deps:check` runs `yarn constraints && yarn dedupe --check`; `yarn lint` builds workspaces first so workspace declaration files exist, then runs lint and dependency checks.
6. **Scripts (root `package.json`).** Preserve existing script names. Add `build` using `yarn workspaces foreach --all --topological --parallel run build`, `start` to build and run the CLI workspace, `clean` to remove `dist`, `coverage`, and `*.tsbuildinfo`, and `deps:check`. Package-level scripts remain in each workspace manifest.
7. **Package-management commands.** Use `yarn install --immutable`, `yarn <script>`, `yarn build`, `yarn workspace <pkg> <cmd>`, and `yarn dlx`. Use `yarn npm audit --all --recursive` for dependency audits, update task 1.7 to use a Yarn-compatible license report, and use `yarn workspaces focus @harness/cli --production` in a pruned copy for production installs. Release publishing uses `yarn changeset` and `yarn workspaces foreach --all --no-private npm publish`.
8. **Containers.** The build stage uses `corepack enable`, `yarn install --immutable`, `yarn build`, then `yarn workspaces focus @harness/cli --production`; copy the focused dependencies and built CLI workspace into `/out`. Keep the non-root runtime stage unchanged.
9. **Specs and docs.** Use Yarn commands throughout specs, `AGENTS.md` and `TASKS.md` files, `CLAUDE.md`, and README. Update CONVENTIONS section 2 for mise, Corepack, Yarn 4, and `nodeLinker: node-modules`. The 1.4 pipeline installs mise 2026.10.4, runs `mise install`, caches Yarn's global cache with a key based on `yarn.lock` and `mise.toml`, then runs `yarn install --immutable`. Regenerate agent indexes.
10. **CI and dependency updates.** Keep the `npm` ecosystem for Yarn Berry lockfiles and add an ignore rule so Dependabot cannot change the Yarn package-manager pin without maintainer review.
**Tests to write:** `scripts/ci/toolchain.test.ts` (unit): verify the exact Node and Corepack pins, Node engine compatibility, integrity-hashed Yarn version, required Yarn configuration, absence of obsolete package-manager files, successful `yarn constraints` and `yarn dedupe --check`, and no legacy package-manager references outside an empty historical-notes allowlist.
**Acceptance Criteria:**
- [ ] Fresh clone: `mise install && yarn install --immutable && yarn lint && yarn typecheck && yarn test:unit && yarn build` exits 0, and `yarn start --version` prints the version.
- [ ] Node, Corepack, and Yarn versions are pinned in exactly one place each, and the toolchain test proves they agree.
- [ ] `yarn constraints` and `yarn dedupe --check` pass and run as part of `yarn lint`.
- [ ] No obsolete package-manager files or references remain in the repository, specs, or docs (scan test passes); `yarn check:agents` passes.

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
- [ ] `yarn lint` exits 0 on the repository with zero errors and zero warnings.
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
1. Build stage: `corepack enable`, `yarn install --immutable`, `yarn build`, then `yarn workspaces focus @harness/cli --production`; copy focused dependencies and the built CLI workspace to `/out`. The focus command is built into pinned Yarn 4.18.1.
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
2. Template `node-setup.yml`: install mise 2026.10.4, run `mise trust` and `mise install`, cache Yarn's global cache with a key based on `yarn.lock` and `mise.toml`, then run `yarn install --immutable`.
3. Stage `static`: steps `yarn lint` (every linter from 1.2 and 1.11, zero warnings), typecheck, and `yarn check:agents` (agent index drift and broken links, from 1.1). A lint failure fails the stage; there is no allow-failure path. Stage `unit`: `yarn test:unit -- --reporter=junit --outputFile=reports/junit.xml --coverage`, then `PublishTestResults@2` (`testResultsFormat: JUnit`, `condition: succeededOrFailed()`) and `PublishCodeCoverageResults@2` (Cobertura) (verify task versions).
4. Stage names must be exactly the ones in CONVENTIONS §7; later tasks add steps, not rename stages.
5. Document the exact check names that branch protection will require (used by 1.9).
**Tests to write:** `scripts/ci/verify-pipeline.test.ts` parses the YAML and asserts: PR trigger present, stages `static` and `unit` exist in order, `static` runs `yarn check:agents`, `PublishTestResults@2` has `condition` containing `succeededOrFailed`, no secret-looking literals.
**Acceptance Criteria:**
- [ ] A PR with a failing unit test shows a failing Azure check and published results.
- [ ] A passing PR publishes JUnit and coverage.
- [ ] Cache hit visible on the second run.

---

## 1.5 NOTICE file and SPDX header check

**Parent:** #1 Foundation
**Task Description:** Add the Apache-2.0 `NOTICE` file and a CI script failing any source file lacking the SPDX header.
**Expected Inputs:** Repo tree; header convention from CONVENTIONS §3.7.
**Expected Output:** `NOTICE`, `scripts/check-spdx.ts`, `yarn check:spdx` script, `static` stage step.
**Dependencies:** `tsx` (or node's type stripping) to run scripts; `fast-glob`.
**Items it depends on:** 1.1, 1.4, 1.1.1.
**Implementation guidance:**
1. `NOTICE` text: project name, `Copyright <YEAR> <COPYRIGHT HOLDER>` where the holder is a placeholder the maintainer replaces (do not invent a legal name; leave `<COPYRIGHT HOLDER>` and open a follow-up note in the PR).
2. Script globs `**/*.{ts,tsx,js,mjs,cjs,sh,yml,yaml}` excluding `node_modules`, `dist`, `coverage`, `**/__golden__/**`, `yarn.lock`.
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
**Expected Output:** `scripts/check-dco.ts`, `yarn check:dco`, `static` stage step (PR builds only), `CONTRIBUTING` snippet in `docs/contributing-dco.md`.
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
**Expected Output:** `config/license-policy.json`, `scripts/check-licenses.ts`, `yarn check:licenses`, `static` stage step.
**Dependencies:** `a Yarn-compatible license report` (verify output shape), `spdx-expression-parse`, `spdx-satisfies`.
**Items it depends on:** 1.1, 1.4, 1.1.1.
**Implementation guidance:**
1. Policy JSON: `allow` (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, Unlicense, CC0-1.0, Python-2.0), `deny` (any `GPL-*`, `AGPL-*`, `LGPL-*`, `SSPL-*`, `BUSL-*`, `CC-BY-NC*`), `exceptions` array of `{ package, version?, reason, expires }`. `config/license-policy.json` is defined by a Zod schema (`LicensePolicy`) and read with `parseJson` (CONVENTIONS 3.10).
2. Evaluate each package's SPDX expression: `A OR B` passes if any alternative is allowed; `A AND B` requires all allowed; unknown or `UNLICENSED` fails unless excepted.
3. Fail on expired exceptions. Print a table of violations with package, version, license.
4. Separate the pure evaluator (`evaluateLicenses(packages, policy)`) from the yarn invocation for testing.
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
2. Stage steps: `docker compose -f infra/compose/docker-compose.test.yml up -d --wait`; `yarn test:integration` with JUnit output; `PublishTestResults@2`; on failure, `docker compose logs --no-color > $(Build.ArtifactStagingDirectory)/compose.log` and `PublishBuildArtifacts@1`; final step `docker compose down -v` with `condition: always()`.
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
**Task Description:** Codify repo governance: templates in the repo and a script plus doc that apply branch protection with explicitly configured required checks.
**Expected Inputs:** Optional GitHub status-check contexts; this task spec format (for the issue template).
**Expected Output:** `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/task.yml`, `scripts/github/apply-branch-protection.sh` (supports `--dry-run` and requires `--apply` for API calls), `docs/maintainers/branch-protection.md`.
**Dependencies:** `gh` CLI (documented, run by a maintainer), `yaml` for tests.
**Items it depends on:** 1.4, 1.6, 1.1.1.
**Implementation guidance:**
1. PR template checklist mirrors CONVENTIONS §8 and asks for the task ID, including the item "`yarn lint` passes with zero errors and warnings, and any new suppression has a written reason".
2. Issue template `task.yml` (GitHub issue forms) has inputs matching the task spec fields (Parent, Description, Inputs, Output, Tests, Acceptance, Dependencies, Depends on).
3. Script calls `gh api -X PUT 'repos/{owner}/{repo}/branches/main/protection'` only with `--apply`, requires PR review count 1, disables force pushes, and requires conversation resolution. Repeatable `--check <context>` options configure required status checks; without them, `required_status_checks` is `null`. DCO runs within the Azure pipeline and is not a separate status check. `--dry-run` prints the payload without calling.
4. CODEOWNERS: default owner is the repo owner; add path owners for `packages/telemetry/`, `packages/pii/`, `infra/collector/` (security-sensitive).
**Tests to write:** `scripts/github/apply-branch-protection.test.ts` (dry-run payload snapshot); YAML parse test for `task.yml` verifying required fields.
**Acceptance Criteria:**
- [ ] Dry run prints a payload with no required status checks by default and includes explicitly configured checks.
- [ ] A bare invocation and unknown arguments exit with usage and status 2; only `--apply` calls GitHub.
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
1. Ecosystems: `npm` (supports Yarn Berry lockfiles; GitHub documents Yarn v1–v4 support) at `/`, `docker` at `/`, weekly schedule.
2. Group minor and patch updates (`groups`), `open-pull-requests-limit: 5`.
3. Ignore semver-major updates for `zod` and `@modelcontextprotocol/*` until a maintainer approves (these gate cross-package compatibility); document how to lift the ignore.
4. Ignore Yarn package-manager version changes so `packageManager` changes require maintainer review.
5. Commit message prefix `deps`; add the `dependencies` label; ensure Dependabot commits satisfy DCO (use the exemption file from 1.6 if needed).
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
**Expected Output:** `.markdownlint-cli2.yaml`, YAML linting through `eslint-plugin-yml` in the ESLint run, `.shellcheckrc`, `.hadolint.yaml`, `cspell.json` with `docs/engineering/project-words.txt`, `.editorconfig` checks, root scripts `lint:md`, `lint:yaml`, `lint:sh`, `lint:docker`, `lint:spell` included in `yarn lint`, fixes to existing files.
**Dependencies:** `markdownlint-cli2`, `eslint-plugin-yml`, ShellCheck, hadolint (pinned container image or binary), `cspell`, `editorconfig-checker` (verify versions and licenses against 1.7).
**Items it depends on:** 1.2, 1.4, 1.1.1.
**Implementation guidance:**
1. Markdown: start from markdownlint defaults; disable only `MD013` (line length; specs use long lines) and allow inline HTML for the comment markers the repo uses (`<!-- BEGIN GENERATED ... -->`, `<!-- test:run -->`, `<!-- claims:allow -->`). Require fenced code blocks to declare a language. Fix existing docs and specs without changing their meaning.
2. YAML: `eslint-plugin-yml` recommended rules plus consistent indentation and no duplicate keys, covering compose, pipelines, collector configs, and `.github`.
3. Shell: ShellCheck at severity `style` on every `*.sh`; scripts start with `set -euo pipefail`.
4. Dockerfiles: hadolint with no ignored rules by default (any ignore needs a reason comment in `.hadolint.yaml`), pinned image digests required.
5. Spelling: cspell over Markdown, code comments, and string literals in `packages/*/src`, with a reviewed project word list. New words are added deliberately in the PR that introduces them.
6. `yarn lint` runs every linter and fails if a required binary is missing (no silent skips). Locally, `LINT_SKIP_CONTAINERS=1` may skip container-based linters with a printed warning; CI never sets it.
**Tests to write:** fixture tests per linter (a known violation fails, a clean file passes); a test that `yarn lint` fails when a required linter binary is absent; the repository passes every linter.
**Acceptance Criteria:**
- [ ] Every Markdown, YAML, shell, Dockerfile, and spelling check passes on the repository with zero errors.
- [ ] Each linter is part of `yarn lint` and of the `static` stage.
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
