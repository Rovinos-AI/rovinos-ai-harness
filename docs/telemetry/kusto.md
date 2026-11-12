# Azure Data Explorer (Kusto)

The ADX exporter writes to the pre-created `HarnessTraces`, `HarnessLogs`, and
`HarnessMetrics` tables. Their column names and types follow the
[Azure Data Explorer exporter documentation at the collector contrib v0.162.0 tag](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.162.0/exporter/azuredataexplorerexporter/README.md#attribute-mapping),
the version pinned by this repository's collector image. The documentation's
table definitions are also the source for the schema and mappings in
`infra/kusto/schema.kql`.

| Table | Exporter columns |
| --- | --- |
| `HarnessTraces` | `TraceID:string`, `SpanID:string`, `ParentID:string`, `SpanName:string`, `SpanStatus:string`, `SpanStatusMessage:string`, `SpanKind:string`, `StartTime:datetime`, `EndTime:datetime`, `ResourceAttributes:dynamic`, `TraceAttributes:dynamic`, `Events:dynamic`, `Links:dynamic` |
| `HarnessLogs` | `Timestamp:datetime`, `ObservedTimestamp:datetime`, `TraceID:string`, `SpanID:string`, `SeverityText:string`, `SeverityNumber:int`, `Body:string`, `ResourceAttributes:dynamic`, `LogsAttributes:dynamic` |
| `HarnessMetrics` | `Timestamp:datetime`, `MetricName:string`, `MetricType:string`, `MetricUnit:string`, `MetricDescription:string`, `MetricValue:real`, `Host:string`, `ResourceAttributes:dynamic`, `MetricAttributes:dynamic` |

`SpanStatusMessage` is the exporter's documented optional traces column and is
included in the table and mapping. The ADX profile names the corresponding JSON
ingestion mappings (`HarnessTracesMapping`, `HarnessLogsMapping`, and
`HarnessMetricsMapping`). Each table uses a 30-day soft-delete retention policy;
change the policy commands in `schema.kql` to use a different retention period.

## Applying the schema

The apply script requires an explicit `--apply` flag and an existing database.
For a real cluster, configure `ADX_CLUSTER_URI`, `ADX_DATABASE`, and either
`ADX_MANAGED_IDENTITY_ID` or the service-principal variables
`ADX_APPLICATION_ID`, `ADX_APPLICATION_KEY`, and `ADX_TENANT_ID`. For a local
emulator, use `--emulator`; that mode permits unauthenticated HTTP only to a
loopback address.

```sh
ADX_CLUSTER_URI=https://example.kusto.windows.net \
ADX_DATABASE=Harness \
ADX_MANAGED_IDENTITY_ID=system \
node --experimental-strip-types scripts/kusto/apply-schema.ts --apply
```

The exporter profile itself uses managed ingestion, which requires streaming
ingestion enabled on a real cluster. The Microsoft
[Kusto emulator installation guide](https://learn.microsoft.com/en-us/azure/data-explorer/kusto-emulator-install)
documents the `kustainer-linux` image, the `latest` or `stable` tags, port 8080,
and the required `ACCEPT_EULA=Y` setting. The test Compose service accepts the
EULA, exposes port 8080 only on the internal test network, and does not publish
the port to the host. The emulator does not support
Microsoft Entra authentication, managed/streaming ingestion, or the queued
ingestion endpoint. The contract test therefore uses named JSON mappings and
inline ingestion; it verifies schema application and row shape, not the live
collector-to-cluster exporter path.

Create a database before applying the schema. For manual local use, start the
emulator with a loopback-only port mapping, for example
`docker run -e ACCEPT_EULA=Y -p 127.0.0.1:8080:8080
mcr.microsoft.com/azuredataexplorer/kustainer-linux:latest`, then run:

```sh
ADX_CLUSTER_URI=http://127.0.0.1:8080 \
ADX_DATABASE=Harness \
node --experimental-strip-types scripts/kusto/apply-schema.ts --apply --emulator
```

End-to-end export to a real ADX cluster remains a manual verification because
this repository has no test cluster configured.
