<!-- SPDX-License-Identifier: Apache-2.0 -->
# Vertex AI Gemini adapter

`@harness/models` provides `VertexAdapter` for Gemini models hosted on Google
Vertex AI. Configure the Google Cloud project and location in the host and use
the Vertex model id in each `ModelRequest`. The adapter uses Google Application
Default Credentials (ADC) by default; configure ADC in the runtime environment
before making requests.

```ts
import { VertexAdapter } from "@harness/models";

const vertex = new VertexAdapter({
  project: "example-project",
  location: "us-central1",
});
```

The adapter translates normalized text, function calls, and tool results to
Vertex AI's Gemini content format. Structured-output requests use native JSON
response schemas. Vertex's supported JSON Schema subset is applied before
sending a request; unsupported keywords are removed and their names are stored
in the returned provider `opaque` part's `droppedSchemaKeywords` field.

Raw assistant content is stored in an `opaque` part with provider `vertex`.
This preserves Vertex-specific fields such as thought signatures when that
assistant turn is sent back to the model. Keep the opaque part alongside the
normalized text and function-call parts when constructing follow-up requests.

The adapter disables SDK HTTP retries. Gateway retry and fallback behavior
remains responsible for retries. Safety blocks map to
`provider_content_filtered`; quota, permission, and other HTTP failures map to
the provider error taxonomy without retaining provider error messages.

The adapter is not registered by `core.createRuntime` or the CLI yet; configure
the adapter directly until the runtime registration task wires provider
configuration through the runtime.
