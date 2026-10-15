# Sandbox workspace layout

The `harness-workspaces` volume is mounted at `/workspaces` in the sandbox
runner. Each run has a separate directory:

```text
/workspaces/<runId>/
├── project/             command working directory
└── .harness/
    ├── offload/         large tool results
    └── tmp/             run-scoped temporary files
```

The volume root is runner-owned (uid `10002`, gid `10003`) and mode `0750`, so
commands cannot create shared artifacts or hard links outside their run
directory. A run's top-level directory is mode `02750`; `project/`, `offload/`,
and `tmp/` use `02770`, while `.harness/` is mode `0750` so commands cannot
replace its trusted children. The setgid bit keeps newly created entries in
the shared group. The deployment must configure the harness service (uid
`10001`) and runner (uid `10002`) with the common gid `10003`. Commands run as
uid/gid `10003`. Only the runner creates, activates, and locks run directories;
the harness accesses offloads through the shared group and does not change
directory modes. The runner locks a run's top-level directory to mode `0700`
when its lease is released or expires.

The authenticated `POST /lease` endpoint explicitly reserves one run ID;
another run receives HTTP `409` with code `sandbox_busy`. Normal `/exec`
requests acquire an execution-scoped lease and release it after the process
group exits, allowing subagents with distinct run IDs to execute between
parent commands. An explicit lease remains pinned until `POST /release` or
expiry. Expiry cannot unlock a workspace while its process group is still
running. Leases expire after ten minutes by default. On runner startup, all
persisted run directories are sealed before the first lease is admitted.

Workspace paths are relative to the run's `project/` directory. The resolver
rejects absolute paths, NUL bytes, traversal segments, overlong paths, and
symlinks. Offloads are direct files in `.harness/offload/`; nested paths are
rejected so commands cannot replace an ancestor during file operations.
Offloaded files are limited to 10 MiB each and 500 MiB across the run by
default. Quota accounting includes the whole run directory and is recounted
periodically.

When a run is activated, the runner clears its `.harness/tmp` and `/tmp`
entries as the command execution uid, which can remove private command-owned
trees. Commands receive an absolute, run-specific `.harness/tmp` as `TMPDIR`.
The runner container also mounts `/tmp` as an ephemeral tmpfs. The harness does
not execute files from the workspace.

## Assumptions and known gaps

The shared group and volume permissions must be preserved by the deployment's
volume driver. The remote runner is the isolation boundary; the explicitly
development-only in-process backend scopes its working directory but does not
provide operating-system filesystem isolation from arbitrary absolute paths
used by a command.
