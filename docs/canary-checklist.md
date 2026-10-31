# Canary checklist

The canary suite exercises known synthetic values at input boundaries and checks captured
telemetry, logs, CLI output, workspace/offload files, event and vault databases, snapshots, and
cassette files. It checks the exact generated values and their percent-encoded and base64 forms;
this is evidence for those values and paths, not a claim that every possible sensitive value is
detected.

When a change adds a sink, boundary, or log path, add a canary scenario in the same PR. Include
the new sink in the captured-output scan and add a negative control if protection on that path
could be bypassed. Keep committed fixtures synthetic; cassette and `__fixtures__` files are
scanned for canary-like patterns.

The hostile MCP App integration tests send run-seeded canaries through rejected telemetry fields
and scan the host's exported spans, logs, metrics, diagnostics, and captured stdout.
The canary pipeline exercises the sample MCP fixture's error-result shape with a run-seeded raw
value and verifies it is removed from persisted and exported sinks.

The approval-screen unit tests inject synthetic canaries in invalid payloads and bridge
errors, checking that the DOM error state and telemetry contain only fixed status text/codes.
Hostile markup remains text, token display does not call approval/reveal tools, and no
payload is written to browser storage.

Eval trials reuse the seeded canary generator and scanner from `@rovinos/eval`. The
`no_canary_leak` grader checks event/vault databases, telemetry, workspaces, and captured
stdout/stderr; workspace values already present in the original fixture are allowed.
