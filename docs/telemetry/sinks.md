# Telemetry sink policies

`telemetry.sinks` declares the collector destinations that may receive harness telemetry. Each sink
has a `Code` identifier, a kind, a maximum data classification, and an enabled flag:

```yaml
telemetry:
  sinks:
    - id: primary
      kind: datadog
      maxClassification: metadata
      enabled: true
```

`maxClassification` defaults to `metadata`, and `enabled` defaults to `true`. Supported kinds map to
the collector profiles and exporters as follows:

| Kind | Collector profile | Exporter |
| --- | --- | --- |
| `datadog` | `profile-datadog.yaml` | `datadog` |
| `kusto` | `profile-adx.yaml` | `azuredataexplorer` |
| `stdout` | `profile-debug.yaml` | `debug` |
| `file` | `profile-test.yaml` | `file/*` |

The `stdout` and `file` profiles are local debugging destinations and are checked with the same
policy as external sinks. Disabled sinks are not checked or started.

## Startup validation

Before creating a runtime, and during `harness doctor`, the harness reads `base.yaml`,
`allowlist.generated.yaml`, `policy-version.generated.yaml`, and the profile associated with each
enabled sink. For every profile pipeline that lists the sink's exporter, validation requires the
generated limiter, filters, transforms, resource policy-version processor, and batch processor in
the committed order. A missing profile, exporter, or processor chain fails with
`sink_policy_violation`; an out-of-date generated policy version fails with
`sink_policy_version_mismatch`.

The collector directory defaults to `infra/collector` relative to the process working directory.
Set `HARNESS_COLLECTOR_CONFIG_DIR` when the deployed files are stored elsewhere. The same directory
must contain the base, generated, and profile YAML files used by the collector.

## Content-capable sinks

Content-capable sinks are disabled unless `telemetry.unsafe.allowContentSinks` is explicitly true:

```yaml
telemetry:
  sinks:
    - id: restricted-debug
      kind: file
      maxClassification: content_tokenized
  unsafe:
    allowContentSinks: true
```

This opt-in emits the structured `telemetry_content_sink_enabled` event with the sink id. Before
enabling it, configure the destination to be access-controlled (for example, restrict filesystem
permissions for a file sink or account permissions for a remote sink). The harness validates the
collector profile and explicit opt-in; it does not inspect the destination's access-control policy.
Keep this setting off unless the destination's access controls have been independently reviewed.

The generated allowlist processors remain mandatory for content-capable sinks as well. This check is
not a change to the default metadata-only event and attribute projection.
