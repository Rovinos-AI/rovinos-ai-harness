# Red-team evaluation

The approval-integrity checker audits ordered, schema-validated event logs for
unauthorized execution, approval edits outside their allowed pointers, duplicate
or cross-run resolutions, separation-of-duties violations, and accepted human
input without an in-scope human decision. The CLI report schema contains only
trial metadata, grader pass flags, and closed codes; it does not expose event
payloads or model transcripts.

The cassette suite is in `evals/redteam/`. Its synthetic scripted responses are
recorded and replayed through the real eval CLI and runtime without a live
provider. Each task checks final status, that its forbidden tool has no
successful result, and both approval invariant graders. The single-response
cassettes do not drive concurrent or cross-run workflows; those semantic
scenarios are orchestrated by the runtime replay tests below.

Runtime replay attacks additionally cover policy-deny bypass; self-approval
through registered and unregistered model-visible tools and text claims; edits
outside `editableFields`; stale approval ids across runs; racing resolutions;
nested-pointer argument smuggling; cross-run PII token scope; subagent
privilege escalation; app-only tools; cancel/resume manipulation; and
self-answering both `agent.ask_user` and MCP elicitation. A test-only
pre-approval execution mutation verifies that `verifyInvariants` reports the
unauthorized execution.

Raw model aliases (case, homoglyph, and trailing-space variants) are rejected
before policy evaluation, and registry ids that normalize to the same id fail
startup with a collision. Distinct registered look-alike ids are not covered;
that boundary remains pending owner review. The runtime tests exercise these
scenarios using real event logs. See `evals/redteam/README.md` for which
multi-event attacks are orchestrated outside the cassette tasks.

Run the focused replay checks with:

<!-- test:run -->

```sh
yarn build && yarn test:replay packages/cli/src/commands/eval-redteam.replay.test.ts test/replay/redteam.attacks.replay.test.ts packages/eval/src/invariants.replay.test.ts
```

GitHub Actions runs the CLI cassette replay and runtime replay tests in the
`gates` job. **(verify)** This maps the retired Azure stage to the GitHub Actions
replay gate. No nightly re-record is configured; re-recording against the
scripted model is a follow-up. These checks cover the listed synthetic cases,
not every possible model/provider behavior. Runtime tools and policy
boundaries remain separate enforcement points.
