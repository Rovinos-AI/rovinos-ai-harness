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

The runner creates these directories with mode `02770`: owner and shared-group
access, plus the setgid bit so newly created entries retain the shared group.
The deployment must configure the harness service (uid `10001`) and runner
(uid `10002`) with a common group; the sandbox image uses gid `10003`. Commands
run as uid/gid `10003`. The runner locks a run's top-level directory to mode
`0700` when its lease is released or expires, so a later command running under
the shared execution identity cannot traverse the previous run's directory.

The harness acquires `POST /lease` with `{ "runId": "<runId>", "ttlMs": 600000
}` before starting or resuming a run. A lease is exclusive to one run ID;
another run receives HTTP `409` with code `sandbox_busy`. Runner exec requests
renew the lease. The harness calls `POST /release` with `{ "runId": "<runId>" }`
when the run suspends or reaches a terminal state. Leases expire after ten
minutes by default if the harness stops responding.

Workspace paths are relative to the run's `project/` directory. The resolver
rejects absolute paths, NUL bytes, traversal segments, overlong paths, and
symlinks. Offloaded files are limited to 10 MiB each and 500 MiB across the
run by default. Quota accounting includes the whole run directory and is
recounted periodically.

Each lease clears `/tmp` in the runner and recreates the run's `.harness/tmp`;
commands receive that run-specific directory as `TMPDIR`. The runner container
also mounts `/tmp` as an ephemeral tmpfs. The harness does not execute files
from the workspace.

## Assumptions and known gaps

The shared group and volume permissions must be preserved by the deployment's
volume driver. The remote runner is the isolation boundary; the explicitly
development-only in-process backend scopes its working directory but does not
provide operating-system filesystem isolation from arbitrary absolute paths
used by a command.
