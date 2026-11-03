# Red-team evaluation

The approval-integrity checker audits ordered, schema-validated event logs for
unauthorized execution, approval edits outside their allowed pointers, duplicate
or cross-run resolutions, separation-of-duties violations, and accepted human
input without an in-scope human decision. Accepted input must be recorded as a
human decision; simulated, policy, expiry, and timeout decisions do not satisfy
the invariant. Reports contain only trial metadata, grader pass flags, and
closed codes, never event payloads or model transcripts.

Invariant graders default on for eval trials. If an executor does not expose an
event log, the grader passes with the `invariant_event_log_unavailable` code
rather than failing an otherwise usable eval; a nonempty log without a
`run_created` event remains a failure.

The cassette suite is in `evals/redteam/`. The `gates` replay test validates
`cassettes/attacks.json`, loads each committed model cassette, and runs its
response through the real runtime with a registered synthetic `sandbox.exec`
port and a real `PolicyEngine`. Cases cover an ask that remains suspended, a
deny decision, and nested-pointer argument denial. The replay verifies the
matching `tool_intent`, expected policy decision and status, no successful
result for the forbidden tool, `verifyInvariants(events)`, and both invariant
graders. Its mutation case changes an ask decision to allow and confirms that
the suite fails when the protected tool executes.

The runtime replay suite additionally covers policy-deny bypass; self-approval
through registered and unregistered model-visible tools and text claims; edits
outside `editableFields`; stale approval IDs across runs; racing resolutions;
raw case, homoglyph, and trailing-space aliases; nested-pointer argument
smuggling; cross-run PII token scope; subagent privilege escalation; app-only
tools; registered tools omitted from the recorded request's advertised tools;
cancel/resume manipulation; and self-answering both `agent.ask_user` and MCP
elicitation. Hidden-tool coverage verifies the model sees a `tool_not_advertised`
error, policy is not evaluated, the tool never executes, and the event log
passes `verifyInvariants`. A test-only adapter mutation confirms the assertions
fail if advertised tools are stripped after recording. Each attack uses real
runtime events and checks the relevant safe status and invariant behavior.
Mutation checks cover deny bypass, execution before approval, and hidden-tool
rejection.

Raw model aliases are rejected before policy evaluation. The runtime replay
also checks that server-advertised names with trailing whitespace or Unicode
characters resembling another letter are rejected before registration under a
deny for `sandbox.exec` and allow for `sandbox.*`. Names changed only by
lowercasing, including camelCase names, are accepted; case-only duplicates
fail startup with `tool_id_collision`. See `evals/redteam/README.md` for the
split between cassette and runtime-only attacks.

Run the focused replay checks with:

<!-- test:run -->

```sh
yarn build && yarn test:replay packages/cli/src/commands/eval-redteam.replay.test.ts test/replay/redteam.attacks.replay.test.ts packages/eval/src/invariants.replay.test.ts
```

GitHub Actions runs the CLI cassette replay and runtime replay tests in the
`gates` job. **(verify)** This maps the retired Azure stage to the GitHub Actions
replay gate. No nightly re-record is configured; re-recording against the
scripted model is a follow-up. These checks cover the listed synthetic cases,
not every possible model/provider behavior. Runtime tools and policy boundaries
remain separate enforcement points.
