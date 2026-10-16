# `@harness/app-telemetry`

Browser-safe, manifest-scoped telemetry for MCP Apps. The shim activates only
after the host confirms `harness.telemetry.emit` is available. Pass `hostReady`
when activation must wait for the MCP Apps connection:

```ts
const telemetry = createAppTelemetry({
  bridge,
  hostReady: appConnection,
  manifest: { spans: ["ui.render", "ui.error"] },
});
```

Call `setHostMetadata(metadata)` with the `_meta` value from host `toolresult`
notifications. The read-only `traceContext.traceId` exposes a valid host
traceparent ID for display only; it is never attached to emitted spans.

`stats()` returns the local dropped-span count, which is not sent to the host.
Call `dispose()` when the app is unloading to clear timers and listeners and
attempt to drain queued spans. Failed sends are retried on a bounded schedule;
the queue is capped at 100 spans.
