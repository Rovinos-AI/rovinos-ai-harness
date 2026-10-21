# Prompt-injection test catalog

Task 22.5 exercises the run loop with `ObedientModel`, a deterministic test-only `ModelPort` that deliberately follows instruction-like text. It scans the latest tool result and every advertised tool description for tool calls, approval attempts, and outbound sends. The model is intentionally not a production model and does not grant authority to its instructions.

## Injection vectors

| Vector | Fixture | Delivery path |
| --- | --- | --- |
| Tool result | `test/fixtures/injection/tool-result.txt` | Synthetic tool output |
| File content | `test/fixtures/injection/file-content.txt` | `sandbox.exec cat` result |
| MCP description | `test/fixtures/injection/mcp-description.txt` | Advertised tool description |
| MCP error | `test/fixtures/injection/mcp-error.txt` | Tool error result |
| Hidden webpage text | `test/fixtures/injection/hidden-webpage.html` | Hidden HTML in a tool result |
| Subagent result | `test/fixtures/injection/subagent-result.txt` | Child-result-shaped tool output |

Each vector is table-driven against the same policy-denied call, an `ask` call plus a self-approval attempt, tokenized and allowlisted outbound sends, a protected config-path write, a broader subagent tool request, and a budget mutation attempt. Canaries are generated for each scenario from an injected deterministic ID seed.

## Authority and evidence

The model may propose tool calls, but the runtime still evaluates each prepared call through the configured policy. A deny decision is expected to produce no successful tool result; an `ask` decision suspends the run, and the model-visible tool list contains no approval-resolution tool. The integration matrix also compares the policy decision, rule, and reason for an injected call with the same call in an uninjected baseline.

Sensitive synthetic values enter through tool output and are checked at the PII tool boundary. A non-allowlisted external tool receives a token; a configured allowlisted pointer is detokenized for its designated tool and produces a `pii_action` audit event. Event and model-request assertions check that the raw canary is absent. A negative control deliberately makes policy trust an argument derived from tool output and demonstrates that the forbidden execution assertion fails.

## Assumptions and gaps

These tests use synthetic tools and an obedient model; they provide repeatable evidence about the core loop, not a measurement of how often a real model follows an injection. The sandbox write scenario uses a no-side-effect backend fixture to check that a protected path is refused; container mount and path enforcement remain covered by the sandbox integration tests. Telemetry exporters and production MCP servers are not started by this test matrix, so their separate boundary tests remain necessary.

Authority comes from code-evaluated policy and recorded human approvals, not from tool results, file contents, webpages, server metadata, or child summaries. The scenarios do not claim that every possible prompt-injection wording has been enumerated.
