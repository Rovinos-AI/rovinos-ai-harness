# Epic #1: Foundation (monorepo and Azure Pipelines CI)

**Goal:** a repo where every later task has a place to live and an automated gate. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 1.1 to 1.10, all size S.

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

## 1.2 Shared tsconfig and ESLint config

**Parent:** #1 Foundation
**Task Description:** Add the shared lint configuration enforcing CONVENTIONS §3, including a local ESLint plugin package that later tasks extend, and the import-direction rule.
**Expected Inputs:** Workspace from 1.1.
**Expected Output:** `eslint.config.js` (flat), `tools/eslint-plugin-harness` (empty rule registry), `.prettierrc`, per-package `tsconfig.json` template, root `lint` script working.
**Dependencies:** eslint, typescript-eslint, prettier, eslint-plugin-import (or `eslint-plugin-boundaries`) (verify flat-config support).
**Items it depends on:** 1.1.
**Implementation guidance:**
1. Rules to enable as errors: `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`, `no-floating-promises`, `consistent-type-imports`, `no-console`, `eqeqeq`.
2. Configure the import-direction rule (CONVENTIONS §1) from the allowlist in `docs/engineering/layers.json` (load the JSON in `eslint.config.js`; do not copy the table), so later packages only add a row there.
3. Create `tools/eslint-plugin-harness/src/index.ts` exporting `{ rules: {} }` and wire it into the config as plugin `harness`; task 4.5 adds `no-raw-tracer`.
4. Each package `tsconfig.json` is `{ "extends": "../../tsconfig.base.json", "include": ["src"], "references": [...] }`.
5. `pnpm lint` runs `eslint .` and `prettier --check .`.
**Tests to write:** `tools/eslint-plugin-harness/src/config.test.ts` using the ESLint Node API against fixture strings: assert `any` is flagged, `console.log` is flagged, a forbidden cross-package import is flagged, and a clean file passes.
**Acceptance Criteria:**
- [ ] `pnpm lint` passes on the repo and fails on each fixture violation (verified by the test).
- [ ] Import-direction rule rejects `@harness/telemetry` importing `@harness/store`.
- [ ] Plugin package builds and loads.

---

## 1.3 Non-root Dockerfile and compose skeleton

**Parent:** #1 Foundation
**Task Description:** Provide a hardened base image build and a compose file that starts a placeholder `harness` service with a healthcheck.
**Expected Inputs:** Workspace; a placeholder `packages/cli` with a `bin` printing the version.
**Expected Output:** `Dockerfile` (multi-stage), `.dockerignore`, `infra/compose/docker-compose.yml`, minimal `packages/cli` (`src/bin.ts`, `package.json` with `bin.harness`).
**Dependencies:** Docker, `node:22-slim` base image.
**Items it depends on:** 1.1.
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
**Items it depends on:** 1.1, 1.2.
**Implementation guidance:**
1. `trigger: [main]`, `pr: [main]`, `pool: { vmImage: ubuntu-latest }`.
2. Template `node-setup.yml`: `NodeTool@0` (22.x), `corepack enable`, `Cache@2` keyed on `pnpm-lock.yaml`, `pnpm install --frozen-lockfile`.
3. Stage `static`: steps lint, typecheck, and `pnpm check:agents` (agent index drift and broken links, from 1.1). Stage `unit`: `pnpm test:unit -- --reporter=junit --outputFile=reports/junit.xml --coverage`, then `PublishTestResults@2` (`testResultsFormat: JUnit`, `condition: succeededOrFailed()`) and `PublishCodeCoverageResults@2` (Cobertura) (verify task versions).
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
**Items it depends on:** 1.1, 1.4.
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
**Items it depends on:** 1.1, 1.4.
**Implementation guidance:**
1. Range: `git log --no-merges --format=%H%x1f%an%x1f%ae%x1f%B%x1e origin/${TARGET_BRANCH}..HEAD`; Azure sets `System.PullRequest.TargetBranch` (pass via env). Ensure the checkout step uses `fetchDepth: 0`.
2. Valid trailer regex: `^Signed-off-by: .+ <[^<>@\s]+@[^<>\s]+>$` (multiline). Require at least one valid trailer per commit; recommend (warn, not fail) that it match the author email.
3. Skip commits authored by `dependabot[bot]` only if configured in `config/dco-exemptions.json` (default empty).
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
**Items it depends on:** 1.1, 1.4.
**Implementation guidance:**
1. Policy JSON: `allow` (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, Unlicense, CC0-1.0, Python-2.0), `deny` (any `GPL-*`, `AGPL-*`, `LGPL-*`, `SSPL-*`, `BUSL-*`, `CC-BY-NC*`), `exceptions` array of `{ package, version?, reason, expires }`.
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
**Items it depends on:** 1.3, 1.4.
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
**Items it depends on:** 1.4, 1.6.
**Implementation guidance:**
1. PR template checklist mirrors CONVENTIONS §8 and asks for the task ID.
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
**Items it depends on:** 1.1, 1.3.
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
