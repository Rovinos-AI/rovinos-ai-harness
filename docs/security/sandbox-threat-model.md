# Sandbox tool-execution threat model

This model covers agent-requested process execution, workspace file operations,
workspace restore, and runner network access. The controls below are design
requirements for the owning tasks, not a claim that the current implementation
already enforces them. Tests cited in the catalog are required before the
corresponding mitigation task is considered complete.

## Assets

| Asset | Security interest |
| --- | --- |
| Host and runner container | Host integrity, isolation from untrusted commands, and bounded resource use |
| Per-run workspace and scratch files | Run confidentiality, integrity, path containment, and cleanup |
| Secrets and vault keys | Keep raw credentials outside child environments, workspaces, snapshots, and logs |
| Event store and snapshots | Preserve run data integrity and prevent cross-run access |
| Network and egress proxy | Prevent unauthorized access to external, private, and metadata destinations |
| Runner API | Restrict execution and workspace operations to authenticated harness requests |

## Actors and assumptions

| Actor | Relevant capability |
| --- | --- |
| Malicious model output | Requests hostile arguments, paths, or long-running and resource-intensive commands |
| Malicious or compromised tool/MCP server | Supplies hostile tool results or attempts unauthorized runner requests |
| Hostile file content or prompt injection | Influences model-generated commands and file operations |
| Compromised dependency | Executes code with the privileges and access available to its process |
| Operator | Configures images, networks, secrets, quotas, and optional hardening runtimes |

The runner is a separate container on an internal network; the harness does not
spawn it and does not mount the Docker socket. Container isolation depends on
the host kernel, container runtime, and correctly applied runtime configuration.
The runner admits only one active run at a time; this does not isolate processes
from each other within that run. External services, the host, and the operator's
secret-management system are assumed to enforce their own access controls.

## Trust boundaries

1. Model and tool output enter the harness as untrusted input and are validated
   before policy evaluation or dispatch.
2. The harness crosses an authenticated internal-network boundary when it
   requests execution or workspace operations from the runner.
3. Runner processes execute across the container/kernel boundary and can access
   only the runner's configured workspace and resources.
4. Network requests cross the runner-to-egress-proxy boundary; direct runner
   egress is denied, and the proxy enforces destination policy.
5. Workspace and snapshot data cross filesystem and restore boundaries; paths
   are resolved within the run root, and archives are filtered before extract.
6. Secrets and vault keys remain outside child environments and workspace
   mounts; event and telemetry boundaries carry tokens or metadata, not raw
   secret values or command content.

## Threat catalog

`activeFromTask` in [`/test/sandbox/cases.json`](../../test/sandbox/cases.json)
controls when the coverage gate begins enforcing each case. It is set to the
task that owns the mitigation and test; the checker skips that case until the
task appears in `docs/progress.json`. A task must add `// threat: T-xx` to its
test source before marking that task complete.

| ID | Threat | Mitigation task | Required test |
| --- | --- | --- | --- |
| T-01 | A mounted Docker socket lets a tool control the host container runtime. | 19.3 | Inspect runner configuration and assert there is no Docker socket mount, privileged mode, or published runner port. |
| T-02 | Excess capabilities or privileges let a tool escape its intended process authority. | 19.7 | Verify the runner image executes as non-root with dropped capabilities and no-new-privileges; assert effective capabilities are zero. |
| T-03 | Parent or service environment variables expose credentials to child processes. | 19.2 | Set a synthetic parent-only secret and assert the child environment does not contain it. |
| T-04 | Mounted host or secret files expose credentials to tool processes. | 19.3 | Assert runner mounts exclude host secrets and vault keys, and a synthetic host-only secret file is unreadable. |
| T-05 | A tool sends data to an unauthorized external destination. | 19.4 | Assert direct egress is denied and proxy requests are denied unless the destination is allowlisted. |
| T-06 | SSRF reaches cloud metadata, loopback, link-local, or private addresses. | 19.4 | Assert metadata and private destinations are rejected, including after DNS resolution and redirects. |
| T-07 | A fork bomb exhausts host or runner process capacity. | 19.3 | Run a process-spawning workload and assert the configured process limit contains it. |
| T-08 | A process exhausts available memory. | 19.3 | Run a memory-consuming workload and assert the configured memory limit terminates or contains it. |
| T-09 | Workspace writes exhaust available disk space. | 19.5 | Write beyond per-file and per-run quotas and assert quota errors without unbounded growth. |
| T-10 | An infinite loop or long-running command occupies a runner indefinitely. | 19.2 | Run a command past its timeout and assert the process group is terminated. |
| T-11 | Excessive stdout or stderr exhausts memory or floods downstream output. | 19.2 | Exceed the output limit and assert captured bytes remain capped and the result is marked truncated. |
| T-12 | Traversal or symlinks escape the run workspace. | 19.5 | Assert absolute paths, `..` traversal, and symlinks resolving outside the workspace are rejected. |
| T-13 | Concurrent runs access another run's files or state. | 19.5 | Hold one run's lease and assert another run is rejected and cannot read its workspace. |
| T-14 | Scratch or workspace data persists into a later run. | 19.5 | Create synthetic data, release the run, and assert a subsequent run cannot access it. |
| T-15 | Setuid binaries grant unintended privilege. | 19.7 | Assert the runner image contains no setuid files and the runtime cannot gain privilege through one. |
| T-16 | Writable root files allow persistent system tampering. | 19.7 | Attempt a root-filesystem write in the runner and assert it fails. |
| T-17 | A malicious restore archive writes outside the workspace. | 19.6 | Restore traversal, absolute-path, and symlink-escape archives; assert rejection and no outside changes. |
| T-18 | An unauthenticated caller invokes the runner API. | 19.3 | Send a request without a valid token and assert the runner returns unauthorized. |
| T-19 | Host-header or origin abuse reaches the runner API under an unintended authority. | 19.3 | Send a request with a disallowed Host or Origin and assert it is rejected. |

## Residual risks

- **Kernel and runtime exploits:** container isolation shares the host kernel;
  a kernel or runtime vulnerability may cross the container boundary. Keep the
  host and runtime patched and assess whether gVisor or Kata Containers is
  applicable to the deployment and its workload.
- **Shared-UID processes within one run:** processes in a runner share a uid and
  workspace. The single-run lease prevents concurrent runs on one runner but
  does not isolate processes launched by the same run.
- **Side channels:** timing, cache, and other shared-resource side channels are
  not eliminated by the controls in this model. Avoid co-locating mutually
  distrustful workloads where this risk is unacceptable.
- **Operator and dependency compromise:** the model does not prevent a
  compromised host, operator account, or trusted dependency from using its
  granted authority. Limit permissions, review image and dependency changes,
  and rotate credentials if compromise is suspected.
