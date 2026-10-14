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
The sample MCP server's failure tool also supplies a run-seeded raw value as an error result to the
canary pipeline, which verifies it is removed from persisted and exported sinks.
