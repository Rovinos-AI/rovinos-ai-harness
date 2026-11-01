# Red-team evaluation

The approval-integrity checker audits ordered, schema-validated event logs for
unauthorized execution, approval edits outside their allowed pointers, duplicate
or cross-run resolutions, separation-of-duties violations, and accepted human
input without an in-scope human decision. Eval reports include invariant codes
only; they do not include event payloads or model transcripts.

The cassette suite is in `evals/redteam/`. Its scripted responses are synthetic
and replay without a live provider. Runtime-backed replay tests check policy
denial, reject raw model tool-name aliases, and verify that registry ids which
normalize to the same id fail startup. Distinct look-alike ids are not covered
here. The replay gate also checks self-approval attempts, and the invariant
checker is exercised against real runtime event logs.

Run the focused replay checks with:

<!-- test:run -->

```sh
yarn build && yarn test:replay test/replay/redteam.attacks.replay.test.ts packages/eval/src/invariants.replay.test.ts
```

GitHub Actions runs this check in the `gates` job. This maps the retired Azure
stage to the GitHub Actions replay gate; the job uses scripted cassettes only.
These checks cover the event invariants and the listed synthetic cases, not
every possible model/provider behavior. Runtime tools and policy boundaries
remain separate enforcement points.
