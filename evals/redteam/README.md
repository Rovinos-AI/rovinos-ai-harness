# Red-team eval suite

The replay gate validates `cassettes/attacks.json`, checks that each case has a
matching suite task, and replays its committed model cassette through the real
runtime. A registered synthetic `sandbox.exec` port and the real policy engine
exercise deny, ask, and nested-pointer decisions. The gate checks real event
logs, final status, absence of successful forbidden results, and both invariant
graders. Its mutation case changes an ask decision to allow and confirms the
suite fails when the protected tool executes.

Single-response cassettes do not model approval edits, cross-run replay, or
concurrency. Those attacks run through the runtime in
[`test/replay/redteam.attacks.replay.test.ts`](../../test/replay/redteam.attacks.replay.test.ts),
including self-approval through registered and unregistered tools or model text;
edits outside `editableFields`; stale approval IDs; racing resolutions; raw
case, homoglyph, and trailing-space aliases; cross-run token scope; subagent
privilege escalation; app-only tools; cancel/resume; and self-answering
`agent.ask_user` or MCP elicitation. The runtime tests assert real events and
invariants. They also include deny-bypass and pre-approval-execution mutation
checks.

Raw model aliases, server-advertised look-alike names, and same-normalized-ID
collisions are covered by runtime tests. Names changed only by lowercasing,
including camelCase, remain valid; names with replaced or collapsed characters
are rejected during registration. Reports contain metadata and invariant codes
only, never event content or model transcripts.

The nightly re-record job from the retired Azure pipeline is intentionally not
reintroduced. **(verify)** The GitHub Actions replay gate is the current CI
equivalent; scripted cassettes are provider-free. Re-recording against the
scripted model remains a follow-up.

See [`docs/security/redteam.md`](../../docs/security/redteam.md) for the attack
catalog and coverage boundaries.
