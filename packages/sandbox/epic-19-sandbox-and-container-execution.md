# Epic #19: Sandbox and container execution

**Goal:** run agent-initiated commands and file operations in an isolated, resource-limited, default-deny environment, with snapshot/restore of the workspace for resume, hardened images, and compose profiles that enforce the security posture. Read `docs/engineering/CONVENTIONS.md` first, plus epics 2 (checkpoints), 10 (network isolation), and 15 (offloading).
**Tasks:** 19.1 to 19.10, all size S.

Shared design for this epic:

- **Never mount `docker.sock`** into the harness or sandbox. The sandbox is a **separate container** (`sandbox-runner`) reached over an internal network, not a container spawned by the harness.
- **One run per runner instance.** Processes inside one runner share a uid and filesystem, so the runner admits a single active run at a time (lease, 19.5); scale by running more replicas. This is a deliberate, documented limit.
- **Default deny:** no network, read-only root filesystem, dropped capabilities, no new privileges, resource limits on every exec. Anything looser is opt-in config and loudly logged.
- `packages/sandbox` contains the `SandboxBackend` interface, the in-process dev backend, the remote client backend, the runner service (`packages/sandbox/runner`), the egress proxy (`packages/sandbox/egress-proxy`), and the workspace and snapshot code.
- Every threat in 19.1 gets a stable id (`T-01`...) that tests cite with a `// threat: T-xx` comment; CI verifies coverage (19.1).

---

## 19.1 Threat model for tool execution, with test cases

**Parent:** #19 Sandbox and container execution
**Task Description:** Write the sandbox threat model and a machine-checkable catalog of test cases that later tasks must implement.
**Expected Inputs:** Architecture in this epic and epics 6, 10.
**Expected Output:** `docs/security/sandbox-threat-model.md`, `test/sandbox/cases.json`, `scripts/check-threat-cases.ts`, `static` stage step.
**Dependencies:** none.
**Items it depends on:** 1.4.
**Implementation guidance:**

1. Document assets (host, workspace, secrets, vault keys, event store, network), actors (malicious model output, malicious or compromised tool/MCP server, hostile file content or prompt injection, compromised dependency), and trust boundaries.
2. Threat catalog (assign ids, each with description, mitigation task, and test requirement): `T-01` container escape via mounted socket; `T-02` capability or privilege escalation; `T-03` secret exfiltration through env vars; `T-04` secret exfiltration through mounted files; `T-05` network exfiltration; `T-06` SSRF to metadata endpoints and private ranges; `T-07` fork bomb; `T-08` memory exhaustion; `T-09` disk filling; `T-10` infinite loop or long run; `T-11` output flooding; `T-12` path traversal and symlink escape in the workspace; `T-13` cross-run data access; `T-14` persistence across runs; `T-15` setuid binaries; `T-16` writable root filesystem tampering; `T-17` tar extraction traversal on restore; `T-18` runner API without authentication; `T-19` host header or origin abuse of the runner API.
3. `cases.json`: array of `{ id, title, mitigationTask, testFile }`. `check-threat-cases.ts` scans `test/**` and `packages/**` for comments `// threat: T-xx` and fails if any catalog id has no referencing test (once the owning task has merged: encode `activeFromTask` and skip ids whose task number is not yet represented by a marker file in `docs/progress/`, which each task PR adds). `cases.json` is parsed with `parseJson` (CONVENTIONS 3.10).
4. State residual risks explicitly (kernel exploits; shared-uid processes within one run; side channels) and the mitigation recommendation (gVisor/Kata runtimes, verify applicability).
**Tests to write:** unit tests for the checker (missing id fails, skipped inactive ids, duplicate ids rejected).
**Acceptance Criteria:**

- [ ] Every threat has an id, mitigation task, and test requirement.
- [ ] CI fails when an active threat lacks a referencing test.
- [ ] Residual risks documented.

---

## 19.2 Backend interface and restricted in-process backend

**Parent:** #19 Sandbox and container execution
**Task Description:** Define the execution contract and a development-only backend, and register a built-in `exec` tool.
**Expected Inputs:** `ExecSpec` requests.
**Expected Output:** `packages/sandbox/src/{types.ts,inprocess.ts,exec-tool.ts}`, package scaffold `packages/sandbox`.
**Dependencies:** Node `child_process`.
**Items it depends on:** 19.1, 2.4, 15.4.
**Implementation guidance:**

1. Types: `ExecSpec = { argv: string[] (1..64 items, each <= 4096 chars), cwd?: string (workspace-relative), env?: Record<string, string> (keys Code-like uppercase, max 32), stdin?: string (<= 1 MiB), timeoutMs: int, limits: { memoryMb, pids, outputBytes, cpuSeconds } }`, `ExecResult = { exitCode: number | null, signal?: string, stdout: string, stderr: string, stdoutBytes, stderrBytes, truncated: boolean, timedOut: boolean, durationMs }`. `interface SandboxBackend { exec(runId: Id, spec: ExecSpec, signal: AbortSignal): Promise<ExecResult>; }`. **No shell strings**: argv only.
2. `InProcessBackend`: `spawn(argv[0], argv.slice(1), { shell: false, detached: true, env: <only PATH and allowed env>, cwd: <resolved workspace path> })`; kill the whole process group on timeout or abort (`process.kill(-pid, "SIGKILL")`); cap captured output at `outputBytes` (truncate, set flag); enforce timeouts with the injected clock for tests.
3. Safety: refuse to run when `NODE_ENV === "production"` unless `sandbox.allowUnsafeInProcess` is true; always log code `sandbox_inprocess_unsafe` at startup. Environment never inherits the parent env.
4. `exec` built-in tool (`ToolPort` provider, tool id `sandbox.exec`): args schema = `ExecSpec` subset; non-idempotent by default; default policy (17.x) should be `ask` (ship this in `examples/policy.yaml`).
5. Outputs flow into the standard PII/offload pipeline (13.7, 15.4); the tool returns `{ exitCode, stdout, stderr, truncated, timedOut }`.
**Tests to write:** echo; non-zero exit; timeout kills process group (child that spawns a grandchild sleep, assert both die); output truncation; env scrubbing (secret in parent env not visible); no shell interpretation (`argv` containing `;`); production refusal; abort handling. Cite `T-10`, `T-11`, `T-03`.
**Acceptance Criteria:**

- [ ] Process groups are fully killed on timeout.
- [ ] Parent environment never reaches the child.
- [ ] In-process backend refuses production use by default.

---

## 19.3 Sandbox runner service container without `docker.sock`

**Parent:** #19 Sandbox and container execution
**Task Description:** Build the isolated runner service and the remote backend that talks to it.
**Expected Inputs:** `ExecSpec` over an authenticated internal HTTP API.
**Expected Output:** `packages/sandbox/runner/src/{server.ts,exec.ts}`, `packages/sandbox/src/remote.ts` (`RemoteSandboxBackend`), `Dockerfile.sandbox`, `sandbox-runner` compose service, token auth.
**Dependencies:** Node `http`, `prlimit` from util-linux in the image (verify availability), Docker.
**Items it depends on:** 19.2, 10.4, 1.3.
**Implementation guidance:**

1. Runner API (JSON over HTTP, internal network only): `POST /exec { runId, spec } -> ExecResult`, `GET /healthz`. Require `Authorization: Bearer <token>` (token from env file/secret, constant-time compare, `T-18`); validate `Host` header against an allowlist (`T-19`); validate bodies with the shared Zod schemas; reject bodies over 2 MiB.
2. Per-exec limits applied by wrapping the command: `prlimit --as=<memoryMb*1MiB> --nproc=<pids> --cpu=<cpuSeconds> --fsize=<bytes> -- <argv...>` (verify flags), spawned as non-root, `detached`, with timeout kill of the process group; also set container-level `pids_limit`, `mem_limit`, `cpus` in compose (`T-07`, `T-08`).
3. Container posture in compose: `read_only: true`, `tmpfs: /tmp:size=64m,noexec`, volume for workspaces, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` (default seccomp profile stays enabled), `user: 10002`, no ports published, attached to the `sandbox` internal network only (no egress, see 19.4), **no volume or env referencing `docker.sock`** (`T-01`).
4. `RemoteSandboxBackend` implements `SandboxBackend` using `fetch` with the token (SecretRef via config `sandbox.runner: { url, token }`), timeouts, and error mapping (`sandbox_unavailable`, `sandbox_busy` for 409, `sandbox_timeout`).
5. Optional hardening: document the `runtime: runsc` (gVisor) compose override (verify), not required.
**Tests to write:** integration tests against the compose runner: echo; fork bomb stays within `pids` limit; memory hog is killed; infinite loop killed at timeout; write to read-only root fails; request without token 401; wrong `Host` header rejected; compose config scan asserts no `docker.sock`, `privileged`, or published ports. Cite `T-01`, `T-02`, `T-07`, `T-08`, `T-10`, `T-16`, `T-18`, `T-19`.
**Acceptance Criteria:**

- [ ] Resource abuse is contained by limits in the integration tests.
- [ ] The runner is unreachable without the token and unreachable from outside the internal network.
- [ ] No Docker socket or privileged mode anywhere.

---

## 19.4 Default-deny egress with an allowlisted proxy

**Parent:** #19 Sandbox and container execution
**Task Description:** Keep the runner offline by default and allow specific destinations only through an enforcing proxy.
**Expected Inputs:** Config `sandbox.egress.allow: { host: string, ports: int[] }[]`.
**Expected Output:** `packages/sandbox/egress-proxy/src/proxy.ts`, compose services `sandbox-egress-proxy` and networks, runner proxy env injection, tests.
**Dependencies:** Node `net`/`http` (CONNECT proxy), probe containers.
**Items it depends on:** 19.3, 10.4.
**Implementation guidance:**

1. Networks: `sandbox` (internal, runner and harness), `sandbox-egress` (internal, runner and proxy), `egress` (external, proxy only). The runner has **no direct route** to the internet; with an empty allowlist the proxy service is not started and the runner is attached only to `sandbox`.
2. Proxy implements HTTP CONNECT and plain HTTP forwarding with a strict allowlist: host (exact match, no wildcards by default) and port. Resolve the host **itself** and reject any destination resolving to loopback, link-local (169.254.0.0/16, includes cloud metadata), private (10/8, 172.16/12, 192.168/16), unique-local (fc00::/7), `::1`, or multicast; connect to the resolved IP (prevents DNS rebinding) and reject IP-literal hosts unless explicitly allowlisted (`T-05`, `T-06`).
3. Runner receives `HTTPS_PROXY`/`HTTP_PROXY` only when the allowlist is non-empty; programs ignoring the proxy simply cannot connect (network isolation, not cooperation).
4. Log only counters: `egress_allowed` and `egress_denied` with a bounded reason code; never log hostnames or URLs.
5. Startup validation rejects `*` hosts and private-range hosts in the allowlist.
**Tests to write:** unit tests for the destination classifier (IPv4/IPv6 private, metadata IP, mapped IPv4-in-IPv6, DNS rebinding simulation with a fake resolver); integration: allowed host reachable via proxy (local test server on the egress network), denied host rejected, direct connection attempts from the runner (bypassing proxy) fail, metadata IP unreachable. Cite `T-05`, `T-06`.
**Acceptance Criteria:**

- [ ] Without allowlist entries the runner has no network at all.
- [ ] Private and metadata destinations are unreachable even if allowlisted by name.
- [ ] Ignoring proxy environment variables does not enable egress.

---

## 19.5 Workspace layout, path safety, quotas, and the single-run lease

**Parent:** #19 Sandbox and container execution
**Task Description:** Define the per-run workspace, a safe path resolver, quotas, and the lease that enforces one active run per runner.
**Expected Inputs:** `runId`, relative paths.
**Expected Output:** `packages/sandbox/src/workspace.ts` (`FsWorkspace implements WorkspacePort`, `resolveWorkspacePath`), runner `POST /lease` and `POST /release`, volume layout docs `docs/sandbox-workspace.md`.
**Dependencies:** Node `fs`.
**Items it depends on:** 19.3, 15.4.
**Implementation guidance:**

1. Layout on volume `harness-workspaces`: `/workspaces/<runId>/project`, `/workspaces/<runId>/.harness/offload`, `/workspaces/<runId>/.harness/tmp`. Directories created `0770`, shared group between harness (uid 10001) and runner (uid 10002) via a common gid and `setgid`; the harness never executes files from the workspace.
2. `resolveWorkspacePath(root, rel)`: reject absolute paths, NUL, `..` segments, paths over 255 characters per segment or 4096 total; join, then `realpath` the **parent** directory and verify it is inside the run root; open files with `O_NOFOLLOW` where supported; refuse symlinks (`T-12`).
3. `FsWorkspace.write/read` use the resolver, enforce `maxFileBytes` (default 10 MiB) and a per-run quota (default 500 MiB, tracked by summing sizes on write and a periodic recount); quota exceeded -> `workspace_quota_exceeded` (`T-09`).
4. Lease: runner `POST /lease { runId, ttlMs }` succeeds only if no other run holds the lease (409 `sandbox_busy` otherwise); every `exec` renews it; `POST /release` frees it; expiry after TTL (default 10 minutes) with the injected clock. The harness acquires the lease at run start/resume and releases on terminal or suspend (`T-13`).
5. Between runs the runner wipes `/tmp` and any per-run scratch, and verifies the previous run's directory is not accessible from the new run's cwd (`T-14`).
**Tests to write:** path resolver table (traversal, symlink to outside, absolute, long names); quota enforcement; lease conflict, renewal, expiry with fake clock; integration: second run's `exec` cannot read first run's files (different cwd and permissions) because the lease prevents concurrency and scratch is wiped. Cite `T-09`, `T-12`, `T-13`, `T-14`.
**Acceptance Criteria:**

- [ ] No path escape is possible through the resolver (fuzz test).
- [ ] A second run cannot start on a busy runner.
- [ ] Quotas enforced and tested.

---

## 19.6 Workspace snapshot and restore

**Parent:** #19 Sandbox and container execution
**Task Description:** Snapshot the workspace into checkpoints and restore it safely on resume.
**Expected Inputs:** Run workspace directory, snapshot store directory.
**Expected Output:** `packages/sandbox/src/snapshot.ts` (`WorkspaceSnapshotter`), integration in `Checkpointer` (2.6) and `resumeRun` (2.7), deletion hook for retention (7.11).
**Dependencies:** `tar` (npm, verify safe-extraction options).
**Items it depends on:** 19.5, 2.6, 2.7, 7.11.
**Implementation guidance:**

1. `snapshot(runId): Promise<WorkspaceRef>`: create `tar.gz` of `/workspaces/<runId>` excluding `.harness/tmp`, write to `/snapshots/<runId>/<snapshotId>.tar.gz` (atomic: write temp file then rename), compute SHA-256; `WorkspaceRef = "ws:" + snapshotId(26) + ":" + first16hex(sha256)` (matches the checkpoint `workspaceRef` pattern from 7.1). Enforce a maximum size (default 1 GiB, `snapshot_too_large`).
2. `restore(runId, ref)`: verify checksum before extraction; extract into a temporary sibling directory with a **safe filter**: reject absolute paths, `..`, symlinks and hardlinks pointing outside, device nodes, FIFOs, setuid bits (strip mode bits), entries over the per-file limit (`T-17`); then atomically swap directories (rename old to `.old`, new into place, delete old).
3. Checkpointer: take a snapshot before `appendWithSnapshot` and set `workspaceRef` in both the `checkpoint_written` event and the snapshot record. On `resumeRun`, if the run directory is missing or `restoreOnResume` is configured, restore from the latest snapshot's ref.
4. Retention: prune snapshot files together with DB snapshots (`snapshotKeep`) and delete all files for a purged run via the retention hook.
5. Snapshots may contain tokenized content only if the workspace did (the PII pipeline tokenizes tool outputs before offload); document that user-uploaded workspace files are the operator's responsibility and snapshots are encrypted at rest when `sandbox.snapshotEncryption` is enabled (AES-GCM via `packages/crypto`, key from the key provider).
**Tests to write:** round trip preserves files and modes (minus setuid); tampered archive fails checksum; malicious archives (traversal, absolute, symlink escape, device node, zip-bomb-like oversize) rejected without side effects; restore atomicity on mid-extraction failure (old workspace intact); pruning and purge hooks; encrypted snapshot round trip. Cite `T-17`.
**Acceptance Criteria:**

- [ ] A crashed run resumes with its workspace restored byte-for-byte.
- [ ] Malicious archives never write outside the target directory.
- [ ] Snapshots are pruned and deleted with their runs.

---

## 19.7 Hardened images: multi-stage, non-root, read-only filesystem

**Parent:** #19 Sandbox and container execution
**Task Description:** Harden the harness and sandbox runner images and add automated checks.
**Expected Inputs:** Dockerfiles from 1.3 and 19.3.
**Expected Output:** hardened `Dockerfile` and `Dockerfile.sandbox`, OCI labels, `scripts/ci/image-hardening.int.test.ts`, docs `docs/security/images.md`.
**Dependencies:** Docker.
**Items it depends on:** 19.3, 1.3.
**Implementation guidance:**

1. Both images: multi-stage (build tools never in the runtime stage), pinned base image tags (record digests in `infra/images.lock` and update through Dependabot, 1.10), non-root numeric `USER`, `WORKDIR` owned by that user, no package manager in runtime stages (remove `apt`, `dpkg` metadata as feasible), strip setuid/setgid bits (`find / -perm /6000 -type f -exec chmod a-s {} +`) (`T-15`).
2. Sandbox runner image includes only what is needed (`node`, `prlimit`, busybox/coreutils, optionally `git` and `python3` through a derived image documented in `docs/sandbox-toolchains.md`); **no docker CLI**, no compilers by default.
3. OCI labels: `org.opencontainers.image.source`, `licenses=Apache-2.0`, `revision` (build arg).
4. Hardening test (integration): for each image assert uid is not 0; no setuid files (`find / -xdev -perm -4000`); `CapEff` in `/proc/self/status` is zero when run with `--cap-drop ALL`; root filesystem read-only write fails with `--read-only`; no `docker` binary present; image history contains no secrets (scan layer commands for `KEY=`/`TOKEN=` patterns) (`T-02`, `T-15`, `T-16`).
5. Document how to rebuild with a different base and how digests are pinned.
**Tests to write:** the hardening integration test described; unit test that Dockerfiles contain a `USER` instruction with a numeric uid and no `ADD http` or `curl | sh` patterns. Cite `T-02`, `T-15`, `T-16`.
**Acceptance Criteria:**

- [ ] Both images pass all hardening checks in CI.
- [ ] No docker CLI, setuid binaries, or embedded secrets.
- [ ] Base images pinned by digest.

---

## 19.8 Compose profiles and the compose security linter

**Parent:** #19 Sandbox and container execution
**Task Description:** Provide dev, test, and prod-like compose configurations with healthchecks, graceful stop settings, and an automated linter for the rendered config.
**Expected Inputs:** Compose files from earlier tasks.
**Expected Output:** `infra/compose/docker-compose.dev.yml`, `docker-compose.prod-like.yml`, healthchecks for all services, `scripts/compose/validate.ts`, `static`/`integration` stage steps, docs `docs/deployment.md`.
**Dependencies:** `docker compose config --format json`.
**Items it depends on:** 19.3, 19.4, 2.8, 10.4.
**Implementation guidance:**

1. Profiles: **dev** (loopback-published ports for control-plane and host, debug exporter, relaxed limits), **test** (existing; extra services for integration tests), **prod-like** (resource limits on every service, `restart: unless-stopped`, `stop_grace_period` greater than `run.shutdownGraceMs` (2.8) plus 5 s, `stop_signal: SIGTERM`, Docker secrets/env files for tokens and keys, no published ports except the control-plane behind a documented TLS proxy example).
2. Healthchecks: harness (`harness healthcheck`, a tiny subcommand reading local state, no network calls), sandbox runner (`GET /healthz`), Postgres (`pg_isready`), Presidio (HTTP probe), control-plane (HTTP), collector via the external probe pattern (10.5).
3. `scripts/compose/validate.ts` renders each profile (`docker compose -f ... config --format json`) and enforces: no `privileged`; no `docker.sock` bind mounts; every non-collector service has `cap_drop: [ALL]`, `security_opt` with `no-new-privileges:true`, `read_only: true` (with explicit tmpfs for writable paths); no `network_mode: host`; only the collector (and sandbox egress proxy when enabled) attached to external networks; prod-like has CPU and memory limits on every service and `stop_grace_period` set; no environment variables with secret-looking names holding literal values.
4. Run the validator in the `static` stage for all profiles (Docker is available on the agents; if not, use a pure YAML fallback) and add a `compose-security` unit test with fixtures of bad configs proving each rule fails.
5. Document upgrade, backup (event store, vault, snapshots as separate volumes with separate backup policies), and key management expectations.
**Tests to write:** validator unit tests with bad-config fixtures (one per rule); integration test bringing up the prod-like profile and checking all health endpoints; graceful stop test: send `SIGTERM` to a running harness container during a fake run and verify a resumable checkpoint (links to 2.8).
**Acceptance Criteria:**

- [ ] Every profile passes the security linter in CI.
- [ ] `docker stop` produces a resumable suspended run within the grace period.
- [ ] Data stores live on separate named volumes with documented backup guidance.

---

## 19.9 Workspace file tools

**Parent:** #19 Sandbox and container execution
**Task Description:** Give agents safe, structured file operations on their workspace so common coding and document tasks do not need shell commands.
**Expected Inputs:** Tool calls with workspace-relative paths.
**Expected Output:** `packages/sandbox/src/fs-tools.ts` (built-in tools `fs.read`, `fs.write`, `fs.edit`, `fs.list`, `fs.search`), runner endpoints `POST /fs/<op>` for the remote backend, tool metadata (idempotency, timeouts), rules in `examples/policy.yaml`, docs `docs/sandbox-workspace.md` section "File tools".
**Dependencies:** none.
**Items it depends on:** 19.5, 2.4, 15.4, 17.1.
**Implementation guidance:**

1. Schemas: `fs.read { path, offset?, length? (<= 256 KiB) }`; `fs.write { path, content (<= 1 MiB), mode: "create" | "overwrite", expectedSha256? }`; `fs.edit { path, edits: { oldText, newText }[] (1..20), expectedSha256? }` where each `oldText` must match exactly once (`edit_no_match`, `edit_ambiguous`); `fs.list { path, depth (0..3), limit (<= 1000) }`; `fs.search { query, regex: boolean, path?, limit (<= 200) }` with regexes passing the shared ReDoS screen.
2. Every path goes through `resolveWorkspacePath` (19.5). `.harness/**` is read-only to these tools (offloaded output is read with `read_offloaded`). Quotas and file-size limits from 19.5 apply. Binary files are detected and returned as `{ binary: true, bytes }` only.
3. Idempotency: `read`, `list`, `search` are idempotent. `write` and `edit` are idempotent only when `expectedSha256` is given (a retry with the same precondition either applies once or fails with `precondition_failed`); otherwise they are non-idempotent.
4. Execution: with the remote backend, operations run inside the runner (same uid and lease as `exec`); with the in-process backend, on the local workspace. Results flow through the PII and offload decorators like any tool output.
5. Example policy: `fs.read`, `fs.list`, `fs.search` allow; `fs.write` and `fs.edit` allow inside the workspace with an `ask` rule for paths matching configured sensitive globs.
**Tests to write:** each operation and its limits; traversal and symlink attempts rejected (cite `T-12`); `.harness` protection; quota enforcement (cite `T-09`); edit uniqueness errors; precondition semantics on retry; binary detection; remote and in-process backends behave identically (shared test table).
**Acceptance Criteria:**

- [ ] Agents can read, write, edit, list, and search workspace files without a shell.
- [ ] No path escape or quota bypass is possible through the tools.
- [ ] Retries with preconditions never apply an edit twice.

---

## 19.10 `web.fetch` through the egress proxy

**Parent:** #19 Sandbox and container execution
**Task Description:** Let agents fetch web content from allowlisted hosts, executed inside the sandbox runner through the egress proxy, with the result treated as untrusted content.
**Expected Inputs:** `web.fetch { url, accept? }` tool calls; `sandbox.egress.allow`.
**Expected Output:** runner endpoint `POST /fetch`, `packages/sandbox/src/web-fetch-tool.ts` (built-in tool `web.fetch`), HTML-to-text converter `packages/sandbox/runner/src/html-text.ts`, docs `docs/sandbox-egress.md` section "web.fetch".
**Dependencies:** an HTML parser for the runner (for example `parse5`; verify license against 1.7).
**Items it depends on:** 19.4, 19.3, 13.7, 15.4.
**Implementation guidance:**

1. The harness process never fetches: the runner performs the request through the egress proxy, so the proxy's allowlist and private-range blocking (19.4) apply (cite `T-05`, `T-06`). With an empty allowlist the tool is not registered.
2. Request rules: `GET` only, `https` only (except allowlisted local test hosts), no cookies, no credentials or auth headers, fixed user agent, at most 5 redirects with every hop re-checked against the allowlist, response cap 2 MiB, total timeout 20 s.
3. Content handling: accept `text/html`, `text/plain`, `text/markdown`, `application/json`; anything else returns `{ binary: true, contentType, bytes }`. HTML is converted to text without scripts and styles; text from hidden elements is dropped and counted (`hiddenTextDropped`), because hidden text is a prompt-injection vector (22.5).
4. Result `{ url (final, without query string if stripQuery), status, contentType, text, truncated, untrusted: true }` flows through PII tokenization and offloading. The tool is idempotent.
5. Telemetry counts outcomes only; URLs and hostnames are never logged (the proxy rule from 19.4).
**Tests to write:** allowlisted fetch through the proxy in the integration stage; denied host; redirect to a denied host blocked; private and metadata IPs blocked even via redirects; size cap and timeout; HTML conversion and hidden-text dropping; non-text types; URL never appears in logs or spans (canary).
**Acceptance Criteria:**

- [ ] Fetches happen only from the runner via the proxy and only to allowlisted hosts.
- [ ] Redirects cannot reach unallowlisted or private destinations.
- [ ] Fetched content is tokenized and marked untrusted.
