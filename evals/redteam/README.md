# Red-team eval suite

`suite.ts` defines a trajectory-checked task per attack label. The replay gate
runs it through the real eval CLI in `--cassette replay` mode using responses
recorded from a synthetic scripted model, with no live provider. Each cassette
task attempts its model-visible tool call and checks final status, absence of a
successful result for the forbidden tool, and both approval invariant graders.
Reports are validated as metadata-only and contain invariant codes rather than
event content or model transcripts.

Single-response cassettes cannot orchestrate multi-run or concurrent actions.
The semantic checks for edits beyond `editableFields`, stale approval ids
across runs, racing resolutions, cross-run token scope, subagent privilege
escalation, app-only controls, cancel/resume, and self-answering
`agent.ask_user` or MCP elicitation therefore remain in
[`test/replay/redteam.attacks.replay.test.ts`](../../test/replay/redteam.attacks.replay.test.ts):
the cases are driven through the runtime and checked against real event logs.
That file also checks policy denial, raw model aliases, and the same-normalized
id registry collision. Raw aliases are rejected; distinct registered
look-alike ids are not tested here.

The nightly re-record job from the retired Azure pipeline is intentionally not
reintroduced. **(verify)** The GitHub Actions replay gate is the current CI
equivalent; scripted cassettes are provider-free. Re-recording against the
scripted model remains a follow-up.

See [`docs/security/redteam.md`](../../docs/security/redteam.md) for the attack
catalog and coverage boundaries.
