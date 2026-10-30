<!-- SPDX-License-Identifier: Apache-2.0 -->
# OpenAI-compatible endpoints

The model gateway can use local or hosted servers that expose the OpenAI Chat
Completions API, including Ollama, vLLM, and LM Studio. Configure each server as
an `openai_compatible` provider. Its `baseUrl` is the server's API root, usually
including `/v1`, and the routed model name must match the name served by that
endpoint.

## Ollama

For an Ollama server on the same host, use its local API URL and explicitly mark
the provider local:

```yaml
models:
  providers:
    - id: ollama
      kind: openai_compatible
      baseUrl: http://localhost:11434/v1
      trust: local
      requestsPerMinute: 30
  routing:
    default:
      - provider: ollama
        model: llama3.1
```

Ollama's OpenAI-compatible endpoint does not require an API key in the default
local setup. The compatible adapter sends a placeholder key for SDK
compatibility; configure an `apiKey` secret reference if your endpoint requires
authentication. Confirm the model name with the Ollama server.

## vLLM

For a vLLM server on the same host, the common API root is
`http://localhost:8000/v1`. If API-key authentication is enabled, reference the
key through the harness secret resolver:

```yaml
models:
  providers:
    - id: vllm
      kind: openai_compatible
      baseUrl: http://localhost:8000/v1
      apiKey: env:VLLM_API_KEY
      trust: local
      capabilities:
        structuredOutput: json_mode
        forcedToolChoice: false
        opaqueRoundTrip: false
  routing:
    default:
      - provider: vllm
        model: served-model
```

The default compatible-endpoint capabilities use JSON mode and conservatively
disable forced tool choice and opaque round trips. Override them only after
checking the server and model version in use. Endpoints that accept the legacy
`max_tokens` request field can set `quirks.useMaxTokens: true`. Set
`quirks.supportsStrictSchema: false` when an endpoint accepts JSON-schema output
but does not support strict mode.

## Transport and trust

HTTPS is required for remote provider URLs unless `trust: local` is selected.
HTTP is accepted for `localhost`, `127.0.0.1`, and `::1` without changing the
trust setting. Selecting `trust: local` permits plain HTTP to other hosts too;
use it only when that network path is intentionally trusted. The trust setting
is also passed to the gateway's request sanitizer.

For configuration fields and routing behavior, see
[model routing](./routing.md).
