# Amazon Bedrock

`BedrockAdapter` uses the AWS SDK for JavaScript v3 Converse API. Configure a region and map
harness model codes to Bedrock model or inference profile IDs:

```yaml
models:
  providers:
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
provider is selected. This includes reasoning text and signatures. SDK binary fields such as
redacted reasoning content are represented as base64 strings in the JSON-serializable blob and
restored to bytes when constructing the next Converse request.

The adapter is not yet registered by the shipped runtime provider factory; that wiring is tracked
in #160. A live test runs only when `AWS_REGION` (or `AWS_DEFAULT_REGION`), `BEDROCK_MODEL_ID`, and
AWS credentials are available.
