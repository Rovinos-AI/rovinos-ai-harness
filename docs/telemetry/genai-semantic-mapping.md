# GenAI semantic-convention mapping

This mapping pins `@opentelemetry/semantic-conventions` **1.44.0** and its
incubating GenAI attribute definitions. The exact dependency pin and names are
checked by `packages/telemetry/src/semconv.test.ts`. GenAI conventions remain
opted out as a global stability mode; the harness emits only the explicitly
listed attributes below.

The mapping is proposed for owner review before merge. Every emitted value is a
Code or a nonnegative integer. No free-form string, array, message, or identifier
outside the configured provider/model codes is mapped.

## Allowed GenAI attributes

| Convention attribute | Source | Type | Presence |
| --- | --- | --- | --- |
| `gen_ai.provider.name` | Configured model provider code | Code | Optional |
| `gen_ai.request.model` | Configured model code | Code | Optional |
| `gen_ai.usage.input_tokens` | Accounted input-token count | Integer | Optional |
| `gen_ai.usage.output_tokens` | Accounted output-token count | Integer | Optional |
| `gen_ai.usage.cache_read.input_tokens` | Accounted cache-read token count | Integer | Optional |
| `gen_ai.usage.cache_creation.input_tokens` | Accounted cache-write token count | Integer | Optional |

These are attached to the existing `harness.model_call` span. The cache mapping
uses the corresponding GenAI cache-read and cache-creation token semantics;
values are emitted only when the model gateway reports them.

## Omitted GenAI attributes

The following fields are intentionally not registered or emitted:

| Convention field(s) | Reason |
| --- | --- |
| `gen_ai.prompt`, `gen_ai.prompt.name`, `gen_ai.completion`, `gen_ai.input`, `gen_ai.output`, `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` | Prompt, completion, message, and instruction content |
| `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`, `gen_ai.tool.description` | Tool arguments, results, definitions, and descriptions may contain user or model content |
| `gen_ai.agent.description`, `gen_ai.evaluation.explanation`, `gen_ai.retrieval.query.text` | Free-form descriptive or query content |
| `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.agent.version`, `gen_ai.conversation.id`, `gen_ai.data_source.id`, `gen_ai.response.id`, `gen_ai.tool.call.id` | Not needed by the harness mapping; identifiers are excluded rather than introducing new correlation or cardinality |
| `gen_ai.operation.name`, `gen_ai.system`, `gen_ai.response.model`, `gen_ai.output.type`, `gen_ai.token.type`, `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.workflow.name` | No approved bounded source mapping in the current model gateway |
| `gen_ai.embeddings.dimension.count`, `gen_ai.evaluation.name`, `gen_ai.evaluation.score.label`, `gen_ai.evaluation.score.value`, `gen_ai.retrieval.documents`, `gen_ai.response.time_to_first_chunk`, `gen_ai.response.finish_reasons` | Not represented by the registered model-call contract |
| `gen_ai.request.choice.count`, `gen_ai.request.encoding.formats`, `gen_ai.request.frequency_penalty`, `gen_ai.request.max_tokens`, `gen_ai.request.presence_penalty`, `gen_ai.request.seed`, `gen_ai.request.stop_sequences`, `gen_ai.request.stream`, `gen_ai.request.temperature`, `gen_ai.request.top_k`, `gen_ai.request.top_p` | Request options are not approved for export; several are free-form or not represented by the gateway contract |
| `gen_ai.usage.completion_tokens`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.reasoning.output_tokens` | No distinct bounded source mapping; the harness uses the normalized input/output token counts above |
| `gen_ai.openai.request.response_format`, `gen_ai.openai.request.seed`, `gen_ai.openai.request.service_tier`, `gen_ai.openai.response.service_tier`, `gen_ai.openai.response.system_fingerprint` | Provider-specific fields are not part of this provider-neutral mapping |

The SDK-side sanitizer also denies GenAI content fields such as prompts,
completions, inputs, outputs, system instructions, tool arguments, tool results,
tool definitions, and tool descriptions before the normal attribute allowlist.
The Collector policy independently keeps only the registered span attributes.

## Intentionally custom harness fields

| Harness field(s) | Reason retained |
| --- | --- |
| `harness.model.attempts`, `harness.model.repair_attempts` | Harness retry and repair behavior has no equivalent approved mapping |
| `harness.model.input_tokens`, `harness.model.output_tokens`, `harness.model.cache_read_tokens`, `harness.model.cache_write_tokens` | Existing harness-specific span names remain for compatibility alongside the GenAI aliases |
| `harness.model.cost_micros` | Cost is harness-accounted and has no corresponding GenAI semantic attribute |
| `harness.model.tokens`, `harness.model.cache_read_tokens`, `harness.model.cache_write_tokens`, `harness.model.cost_micros`, `harness.model.latency_ms` metrics | Existing counters and histograms remain custom; their names, units, bounded provider/model labels, and dashboard queries are unchanged |
| `harness.context.*`, `harness.tool.definition_*` | Harness context and tool-definition counts are custom metadata, not GenAI attributes |

## Migration notes

This is additive for future `harness.model_call` spans. It does not change event
schemas, persisted runs, metric instruments, Collector sink contracts, or the
Datadog dashboard. Older spans remain valid without the optional attributes.
The generated telemetry catalog and Collector allowlist must be regenerated
with any change to this mapping. A semantic-conventions version upgrade requires
rechecking the exact names, types, omissions, privacy tests, Collector policy,
and this table before changing the pinned package version.
