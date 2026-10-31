# Red-team evaluation

The approval-integrity checker audits ordered, schema-validated event logs for
unauthorized execution, approval edits outside their allowed pointers, duplicate
or cross-run resolutions, separation-of-duties violations, and accepted human
input without an in-scope human decision. Eval reports include invariant codes
only; they do not include event payloads or model transcripts.

The cassette suite is in `evals/redteam/`. Its scripted responses are synthetic
and replay without a live provider. The replay gate validates each task's
trajectory expectations and runs the invariant checker against a self-resolved
`agent.ask_user` input mutation. Registry and policy tests separately reject
tool-name aliases and nested argument smuggling.

Run the focused replay checks with:

<!-- test:run -->

```sh
yarn build && yarn test:replay packages/eval/src/invariants.replay.test.ts
```

GitHub Actions runs this check in the `gates` job. This maps the retired Azure
stage to the GitHub Actions replay gate; the job uses scripted cassettes only.
These checks cover the event invariants and the listed synthetic cases, not
every possible model/provider behavior. Runtime tools and policy boundaries
remain separate enforcement points.
