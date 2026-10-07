# Epic #21: Docs, examples, and release

**Goal:** make the project understandable, runnable, contributable, releasable, and honest about its guarantees. Documentation is tested like code wherever possible. Read `docs/engineering/CONVENTIONS.md` first.
**Tasks:** 21.1 to 21.8, all size S.

Shared design for this epic:
- **Docs as tests.** Commands in tutorials are executed in CI; links and diagrams are validated; generated references are built on every PR.
- **Honest claims.** The project never claims that sensitive data "cannot" leak; it documents structural guarantees, best-effort measures, verification evidence, and known gaps (21.8, with a lint against absolute claims).
- Tooling: `markdownlint-cli2`, a small link checker script, `mermaid` (parser API for diagram syntax checks), `typedoc` + `typedoc-plugin-markdown`, Playwright for screenshots.
- Place this planning folder in the repo under `docs/engineering/tasks/` so contributors can see the task specs.

---

## 21.1 README and architecture overview

**Parent:** #21 Docs, examples, and release
**Task Description:** Write the project README and architecture documentation with validated diagrams.
**Expected Inputs:** Architecture decisions across all epics.
**Expected Output:** `README.md`, `docs/architecture.md`, `docs/glossary.md`, `docs/decisions/README.md` (ADR index), `scripts/docs/check-links.ts`, `scripts/docs/check-mermaid.ts`, `.markdownlint-cli2.yaml`, docs checks in the `static` stage.
**Dependencies:** `markdownlint-cli2`, `mermaid` (Node parse API, verify), Azure Pipelines status badge URL (from the Azure project, documented in the README).
**Items it depends on:** 1.4.
**Implementation guidance:**
1. README sections: one-paragraph description; what makes it different (event-sourced resumability, metadata-only telemetry, MCP Apps approvals, PII tokenization at every boundary); **guarantees and limits** (link to `docs/guarantees.md`, 21.8, even before it exists: create a stub with a TODO that 21.8 replaces and make the link checker accept it); quickstart pointer (21.2); architecture diagram; repository layout (from CONVENTIONS §1); status (alpha) and license (Apache-2.0); contributing and security links.
2. `docs/architecture.md`: Mermaid diagrams for (a) system context and components, (b) the event log and run state machine, (c) telemetry path (events -> safe projection -> allowlist -> sentinel -> collector -> backends), (d) MCP Apps approval flow (sequence diagram), (e) subagent run tree. Each diagram is followed by a short explanation and links to the relevant epics and ADRs.
3. `check-links.ts`: verify relative links and anchors in all Markdown files resolve (headings slugified like GitHub), no external network calls in CI by default (an `--external` flag checks HTTP links on the nightly schedule).
4. `check-mermaid.ts`: extract fenced `mermaid` blocks and parse them with the Mermaid parser; fail on syntax errors.
5. `docs/decisions/` holds ADRs (14.1 is the first); README index lists them.
6. `README.md` already exists as the pre-implementation specification overview (system, data flows, and build plan, with Mermaid diagrams). Revise it rather than replacing it: switch the status from "specification stage" to the real state, add the sections above that are missing, keep its diagrams consistent with `docs/architecture.md` (move detail there if the README grows too long), and run it through the link, Mermaid, and claims checks.
**Tests to write:** unit tests for the link checker (broken link, broken anchor, valid anchors with duplicate headings) and the Mermaid extractor (valid and invalid fixtures); markdownlint runs clean on the repo.
**Acceptance Criteria:**
- [ ] README renders correctly on GitHub with diagrams.
- [ ] CI fails on broken links, anchors, or invalid Mermaid.
- [ ] Architecture doc covers all five diagrams.

---

## 21.2 Quickstart with compose and a runnable sample

**Parent:** #21 Docs, examples, and release
**Task Description:** Provide a quickstart that works with no API keys (fake model) and optionally with a real provider, verified by CI.
**Expected Inputs:** Compose files, CLI.
**Expected Output:** `examples/quickstart/{docker-compose.quickstart.yml,harness.config.yaml,.env.example,fake-model.script.json}`, `docs/quickstart.md`, `scripts/docs/run-doc-tests.ts`, `test/quickstart.int.test.ts`.
**Dependencies:** Docker.
**Items it depends on:** 21.1, 19.8, 2.10, 12.3.
**Implementation guidance:**
1. Quickstart flow (documented and executable): copy `.env.example`; generate keys with `harness keys generate` (placing the base64 key in `.env`, never committed); `docker compose -f examples/quickstart/docker-compose.quickstart.yml up -d --wait`; run a sample (`harness run --input examples/quickstart/task.json --fake-model examples/quickstart/fake-model.script.json`); `harness inspect <runId>`; trigger an approval scenario and resolve it via `harness approvals approve`; resume; stop and clean.
2. Mark runnable blocks in `docs/quickstart.md` with an HTML comment above the fence: `<!-- test:run -->`. `run-doc-tests.ts` extracts such blocks, executes them sequentially in a temp working copy, substitutes placeholders (`<runId>` captured from earlier output via named captures `<!-- capture:runId=... -->` conventions documented in the script header), fails on any non-zero exit, and always runs cleanup blocks (`<!-- test:cleanup -->`).
3. `test/quickstart.int.test.ts` invokes the doc runner in the Azure `integration` stage.
4. Add an "Using a real provider" section (not tested) showing config with `SecretRef` for an API key and the routing config; reference `docs/secrets.md`.
5. The quickstart stack uses the prod-like security settings (read-only, dropped caps) to avoid advertising insecure defaults.
**Tests to write:** unit tests for the doc runner (block extraction, capture substitution, cleanup always runs, failure propagation) and the integration test above.
**Acceptance Criteria:**
- [ ] A new user can complete the quickstart with only Docker.
- [ ] CI executes the documented commands and fails when they break.
- [ ] No secrets or real keys appear in the examples.

---

## 21.3 Approval app walkthrough and demo

**Parent:** #21 Docs, examples, and release
**Task Description:** Document the approval experience across clients with generated screenshots and a demo script.
**Expected Inputs:** Approval app, reference host, control-plane.
**Expected Output:** `docs/approval-app.md`, `examples/approval-demo/` (script and config), `scripts/docs/screenshots.ts`, `docs/images/approval-*.png`.
**Dependencies:** Playwright.
**Items it depends on:** 5.6, 18.7, 21.2.
**Implementation guidance:**
1. `examples/approval-demo/run.sh` starts the control-plane and reference host, creates a run that suspends on an `ask` rule using the fake model, and prints the URLs.
2. `docs/approval-app.md` sections: how it works (events, suspension, resume); using the **reference host**; using an **MCP Apps-capable client** (generic instructions plus the compatibility matrix link from 18.7, marking client specifics as unverified); using **elicitation** and the **CLI** fallbacks; reveal behavior (off by default, audited, auto-masking); editing arguments; troubleshooting table by error code.
3. `screenshots.ts` uses Playwright with deterministic fixture data (fixed fake clock and ids, synthetic values) to produce images for: pending approval, edit form, reveal confirmation dialog, expired state, fallback instructions card. Images are committed; CI does not diff them but a nightly job regenerates and uploads them as an artifact for manual comparison.
4. Include a security note section linking to 18.5 and 21.8.
**Tests to write:** a docs test that every image referenced in the doc exists; the screenshot script runs headless in the integration stage and produces non-empty PNGs of expected dimensions (smoke only).
**Acceptance Criteria:**
- [ ] Walkthrough covers app, elicitation, and CLI paths.
- [ ] Screenshots are reproducible from a script.
- [ ] Doc states which client behaviors are unverified.

---

## 21.4 Example eval suite and tutorial

**Parent:** #21 Docs, examples, and release
**Task Description:** Ship a small, working eval suite that demonstrates graders, trajectory assertions, privacy checks, and cassettes.
**Expected Inputs:** Eval runner (epic 16).
**Expected Output:** `examples/evals/{suite.ts,fixtures/**,cassettes/*.cassette.json,README.md}`, `docs/evals-tutorial.md`, CI replay-stage step.
**Dependencies:** none.
**Items it depends on:** 16.11, 16.8.
**Implementation guidance:**
1. Three tasks: (a) **file edit**: fix a small bug in a fixture project, graded by `test_command` and `file_diff`; (b) **structured extraction**: produce JSON validated by `schema_valid` with a Zod schema exported from `examples/evals/schemas.ts`; (c) **privacy**: input contains synthetic PII canaries; graded with `trajectory` assertions (`no_raw_pii_at_model_input`, `tool_never_called` for an exfiltration tool) and `no_canary_leak`.
2. Cassettes are recorded once with the scripted fake provider (so they are fully synthetic) and committed; every cassette declares `containsRealData: false`.
3. Tutorial walks through running the suite, reading the report, adding a grader, recording a cassette against a real model, and comparing two variants (`variants.yaml`).
4. CI: the example suite runs under `harness eval run examples/evals/suite.ts --cassette replay --fail-under 1.0` in the `gates` stage so the example cannot rot.
**Tests to write:** the CI replay run itself (expects all tasks to pass); a test asserting the cassettes are synthetic (canary-like pattern scan) and declare `containsRealData: false`; tutorial command blocks executed through the doc runner (21.2).
**Acceptance Criteria:**
- [ ] The example suite passes offline in CI.
- [ ] Tutorial commands are executed by the doc test runner.
- [ ] Cassettes are synthetic and declared as such.

---

## 21.5 CONTRIBUTING, CODE_OF_CONDUCT, and SECURITY

**Parent:** #21 Docs, examples, and release
**Task Description:** Add the community and security policy files expected of an open source project.
**Expected Inputs:** Project processes from epic 1.
**Expected Output:** `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/engineering/README.md` (explaining the task spec folder), `scripts/docs/check-community-files.ts`.
**Dependencies:** none.
**Items it depends on:** 1.6, 1.9, 21.1.
**Implementation guidance:**
1. `CONTRIBUTING.md`: setup (Node, pnpm, Docker), workflow (task IDs from `docs/engineering/tasks/`, one PR per task, title format), DCO sign-off with the exact `git commit -s` instructions, local checks (`pnpm lint`, `pnpm test:unit`, `pnpm check:spdx`), how to run integration tests locally, how Azure Pipelines checks gate merges, code style pointers to `docs/engineering/CONVENTIONS.md`, and how to propose changes to guarantees (requires updating 21.8 and canary scenarios).
2. `CODE_OF_CONDUCT.md`: adopt the Contributor Covenant. **Download the official text for the current version from contributor-covenant.org (verify version, 2.1 at time of writing) rather than retyping it**, keep its attribution and license notice (CC BY 4.0), and fill in the enforcement contact method (maintainer decision; do not invent an address).
3. `SECURITY.md`: supported versions table, private reporting through GitHub Security Advisories, expected response times (maintainer decision; placeholders flagged in the PR), scope (what counts as a vulnerability), **explicit high-severity class for any PII or telemetry leakage and sandbox escape reports**, disclosure policy, and a note that the project provides no compliance certification.
4. `check-community-files.ts` verifies the files exist, contain required headings (`## Reporting`, `## Supported versions`, DCO section) and that placeholders such as `<MAINTAINER_EMAIL>` are flagged as warnings (error when `RELEASE=1`).
**Tests to write:** unit tests for the checker (missing files, missing headings, placeholder warning vs release error).
**Acceptance Criteria:**
- [ ] All three files present with required sections.
- [ ] Code of Conduct uses the official text with attribution.
- [ ] Placeholders block releases until filled.

---

## 21.6 Versioning, changelog, and release pipeline

**Parent:** #21 Docs, examples, and release
**Task Description:** Automate versioning with Changesets and add a tag-triggered Azure release stage that publishes packages and container images.
**Expected Inputs:** Merged changes with changesets; a git tag.
**Expected Output:** `.changeset/config.json`, `docs/releasing.md`, `release` stage in `azure-pipelines.yml`, `scripts/release/verify-release.ts`, PR dry-run job.
**Dependencies:** `@changesets/cli`, npm registry token and a container registry service connection (maintainer setup, documented), `cosign` (used in 22.4).
**Items it depends on:** 21.5, 1.4, 19.7.
**Implementation guidance:**
1. Changesets: initialize with `fixed` or `linked` groups for packages released together (decision recorded as an ADR: recommended `linked` for all `@harness/*` packages); CI check `pnpm changeset status --since=origin/main` on PRs requires a changeset for changes under `packages/**` (except docs-only).
2. Release stage triggers on tags `v*`: run all earlier stages, `pnpm changeset version` verification (the tag must match the version in `package.json`, `verify-release.ts`), build, `pnpm -r publish` (to npm with an automation token from variable groups or Key Vault), build and push images to a registry (GHCR recommended for open source; service connection documented) tagged `vX.Y.Z` and `latest`, create a GitHub Release with notes from the changelog (`GitHubRelease@1` task, verify).
3. **Provenance note:** npm provenance attestations require a supported CI identity provider; document that Azure Pipelines publishing lacks npm provenance and record the decision (alternative: publish from GitHub Actions) in an ADR.
4. PRs run the release stage in **dry-run** mode (`pnpm -r pack --dry-run`, `docker build` without push, `verify-release.ts --dry-run`).
5. Blockers for release: `check-community-files.ts` with `RELEASE=1`, canary and replay gates green, no failing license scan, SBOM and signing steps from 22.4 when available.
**Tests to write:** `verify-release.ts` unit tests (tag/version match and mismatch, missing changeset); pipeline YAML structure test (stage conditions, dry-run on PRs, no literal secrets); `pnpm pack` dry-run test in CI.
**Acceptance Criteria:**
- [ ] A tagged commit builds, tests, and publishes only when all gates are green.
- [ ] PRs exercise the release path in dry-run mode.
- [ ] Provenance decision is recorded.

---

## 21.7 Generated API reference

**Parent:** #21 Docs, examples, and release
**Task Description:** Generate API docs from TSDoc on every PR and enforce documentation coverage of public exports.
**Expected Inputs:** Package entry points.
**Expected Output:** `typedoc.json`, `scripts/docs/api-coverage.ts`, `docs:api` script, pipeline artifact `api-docs`.
**Dependencies:** `typedoc`, `typedoc-plugin-markdown` (verify compatibility with the pinned TypeScript).
**Items it depends on:** 21.1.
**Implementation guidance:**
1. Configure TypeDoc with `entryPointStrategy: "packages"`, one entry per publishable package (`packages/*/src/index.ts`), `excludeInternal: true`, `treatWarningsAsErrors: true` (broken `@link`s and missing exports fail).
2. Generated output (Markdown) goes to `docs/api/` which is **gitignored**; the pipeline publishes it as an artifact.
3. `api-coverage.ts` walks the TypeDoc JSON model and computes the percentage of exported functions, classes, interfaces, and type aliases having a description; fail below 90 percent overall and list undocumented exports; allow per-symbol `@internal`.
4. Public API rule: anything exported from a package `index.ts` is public; document in `docs/api-policy.md` how to mark internals and how breaking changes map to Changesets.
**Tests to write:** unit tests for the coverage calculator on a fixture TypeDoc JSON; CI step runs TypeDoc across the repo.
**Acceptance Criteria:**
- [ ] API docs build without warnings on every PR.
- [ ] Documentation coverage is at least 90 percent and enforced.
- [ ] Public vs internal API policy is documented.

---

## 21.8 Guarantees and limits documentation

**Parent:** #21 Docs, examples, and release
**Task Description:** Write the authoritative description of what the system guarantees structurally, what is best effort, and what is not covered, with a lint against overclaiming.
**Expected Inputs:** Epics 4, 8, 10, 12, 13, 19 outputs and tests.
**Expected Output:** `docs/guarantees.md`, `scripts/docs/lint-claims.ts`, link from the README and `SECURITY.md`.
**Dependencies:** none.
**Items it depends on:** 21.5, 8.6, 19.1, 10.6, 3.7.
**Implementation guidance:**
1. Sections: **Structural guarantees** (closed telemetry schemas and allowlists at three layers; vault separate from the event log; content encrypted at rest; app telemetry validated and host-stamped; sandbox default-deny), each with the **evidence** (test names and CI jobs: canary suite 8.5, collector fixture 10.6, hostile app suite 3.7, sandbox hardening 19.7) and the **assumptions** it relies on.
2. **Best-effort measures:** PII detectors (precision/recall report link 13.11), leak sentinel variant matching (supported transforms list), prompt-injection resistance.
3. **Known gaps:** the list from 8.6 (encryption, compression, steganography, translation, split values), side channels, kernel-level sandbox escapes (19.1 residual risks), provider-side logging by third-party model APIs, user-supplied files in workspaces, human reveal behavior, compromised host.
4. **Operator responsibilities:** key management and rotation, retention settings, provider trust configuration, network policy, access control to the control plane, backups, monitoring and alerts (links to epic 11 runbooks).
5. **Non-claims:** the project does not certify compliance with GDPR, HIPAA, or other regimes and is not legal advice.
6. `lint-claims.ts`: scan `README.md` and `docs/**/*.md` for banned absolute phrases (`completely secure`, `100% safe`, `impossible to leak`, `guaranteed compliant`, `never leaks`, `cannot leak`, case-insensitive) and fail unless the line carries an inline `<!-- claims:allow -->` marker (used when quoting them as examples of what **not** to say). Run in the `static` stage.
**Tests to write:** claim linter unit tests (banned phrase detected, allow marker honored, code fences ignored optionally by flag); a docs test verifying every evidence link points to an existing test file or CI job name.
**Acceptance Criteria:**
- [ ] Every guarantee cites verifiable evidence and its assumptions.
- [ ] Known gaps and non-claims are explicit.
- [ ] CI blocks absolute security claims in docs.
