# Amazon Bedrock

> **Not registered by the shipped runtime factory:** this adapter and its config are available to
> package-level callers, but normal runtime routing cannot select Bedrock until provider-factory
> wiring is added. The example below therefore does not enable Bedrock by itself.
>
> **No streaming path:** task 14.19 implements the synchronous Converse API only. `ConverseStream`
> support is outside issue #160's scope and belongs with the separate streaming interface in task
> 14.16 (PR #463).

`BedrockAdapter` uses the AWS SDK for JavaScript v3 Converse API. Configure a region and map
harness model codes to Bedrock model or inference profile IDs:

```yaml
models:
  providers:
    # Package-level adapter only; runtime provider-factory wiring is not yet available.
    - id: bedrock
      kind: bedrock
      region: us-east-1
      modelIds:
        nova-pro: amazon.nova-pro-v1:0
```

Route requests using the configured provider ID and model code, such as `bedrock/nova-pro`. The
adapter resolves AWS credentials through the SDK's default provider chain. Do not place access keys
or other AWS credentials in provider configuration; `apiKey` is not accepted for Bedrock.

The Converse adapter disables SDK retries (`maxAttempts: 1`); retry policy belongs to the model
gateway. It maps text, tools, results, token usage, and stop reasons. Bedrock defaults to forced-tool
structured output. Override the model capabilities only when the configured model supports a higher
structured-output rung; native JSON schema output uses Converse `outputConfig`.

Assistant response content is retained in a Bedrock `opaque` part and replayed when the matching
provider is selected. This includes reasoning text and signatures. SDK binary fields such as image
and redacted reasoning content are represented as base64 strings in the JSON-serializable blob and
restored to bytes only at their provider-defined binary paths; JSON tool inputs remain unchanged.

A live test runs only when `AWS_REGION` (or `AWS_DEFAULT_REGION`), `BEDROCK_MODEL_ID`, and AWS
credentials are available.
