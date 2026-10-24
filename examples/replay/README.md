# Replay from a trace

From the repository root, install the pinned toolchain and build the packages:

```bash
mise install
yarn install --immutable
yarn build
```

Then run the synthetic example:

<!-- test:run -->

```bash
node examples/replay/run.mjs
```

Expected output (the trace ID is generated for each run):

```text
Original trace ID: 0123456789abcdef0123456789abcdef
Run status: completed
Replay status: completed
Replay trace ID: fedcba0987654321fedcba0987654321
Run events reproduced: yes
Replay trace linked: yes
Canary in exported spans/logs: absent
```

The sample runs a fake model with a synthetic content canary (not real personal data), exports spans
and logs through the metadata-only telemetry SDK, reads the original trace ID from the exported run
span, resolves the recorded events by that ID, and replays their recorded responses. Its assertions
check that replay preserves the event sequence and status, the replay span links to the original
trace, and the canary is absent from both exported spans and logs.

Watch the [short terminal recording](demo.cast).
