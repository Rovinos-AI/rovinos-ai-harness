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

The advisory MCP conformance gate scans its archived report tree for the synthetic bearer-token
canaries; `scripts/ci/mcp-conformance-report-safety.canary.test.ts` is the negative control for
that report sink.

The hostile MCP App integration tests send run-seeded canaries through rejected telemetry fields
and scan the host's exported spans, logs, metrics, diagnostics, and captured stdout.
The canary pipeline exercises the sample MCP fixture's error-result shape with a run-seeded raw
value and verifies it is removed from persisted and exported sinks. It also enables harness-owned
metrics through an exporting reader and scans metric names, attributes, and exemplar data.
The SDK/CLI metrics export integration sends a run-seeded prompt canary through both public paths
and checks the local OTLP receiver for the expected counter and histogram without that value.

Hostile elicitation integration tests scan returned and persisted input events, model context,
and exported telemetry in both protocol eras. Legacy input unit tests also verify that accepted
and policy-declined requests return the storage-tokenized message rather than the raw server
message; returning the original event instead makes these regressions fail.

The approval-screen unit tests inject synthetic canaries in invalid payloads and bridge
errors, checking that the DOM error state and telemetry contain only fixed status text/codes.
Hostile markup remains text, token display does not call approval/reveal tools, and no
payload is written to browser storage.

Eval trials reuse the seeded canary generator and scanner from `@rovinos/eval`. The
`no_canary_leak` grader checks event/vault databases, telemetry, workspaces, and captured
stdout/stderr; workspace values already present in the original fixture are allowed.

The deterministic live-eval model-path integration uses a seeded synthetic API-key canary
with a loopback OpenAI-compatible provider. It scans gateway/client request and response
payloads, runtime events, MCP arguments, and provider request bodies for the raw,
percent-encoded, and base64 forms. The captured host-only authorization header is the
positive control: the scanner must find that sink and no other captured sink. The same
scenario checks allow, deny, and human approval/resume through the ordinary runtime.
A negative control deliberately inserts each credential form into a client-payload
capture and requires the scan to identify that sink.
The end-to-end skeleton also routes its MCP CLI approval/edit/deny scenario through the
Unix-socket eval gateway. These checks make no paid provider calls and do not demonstrate
container isolation or coverage of every possible credential encoding.

The separate `test/live-eval-model-path.live.test.ts` smoke is disabled unless
`HARNESS_LIVE_EVAL=1`, `HARNESS_LIVE_EVAL_PROFILE=restricted-staging`,
`HARNESS_LIVE_EVAL_API_KEY`, and `HARNESS_LIVE_EVAL_MODEL` are supplied. Operators must
provide a restricted staging key; the profile flag is an operator attestation, not
remote verification of that key's permissions. It uses only an in-memory synthetic MCP
fixture and caps the host session at four provider requests. Run it explicitly with
`yarn exec vitest run --project live test/live-eval-model-path.live.test.ts`;
it is not part of deterministic integration blockers.
