# Replay regression gate

The GitHub Actions `gates` job runs `yarn test:replay` against the committed synthetic fixture in `test/replay/golden/`. The fixture contains a model cassette and a normalized, content-free replay signature. Tests re-record the scripted run in memory, replay it through the current harness, and compare the result with that signature.

The scenario uses only a scripted model, synthetic tools, and a synthetic policy. It includes idempotent and non-idempotent tool calls, an edited approval, a policy denial, checkpoints, a crash-and-resume segment, context compaction, and a final answer. The content-free signature covers both the replay output and the isolated compaction coverage pass. Replay uses recorded model and tool results and resolves approvals from the source event log; it does not call real providers, tools, or people.

## Tokenized request verification

Version 2 `model_request` events include a metadata-only `requestParametersHash` covering every non-message request parameter except the volatile request ID, including tools and the stable-prefix message count. The `requestHash` combines that digest with the stored messages; the PII storage boundary recomputes it after tokenization. Replay verifies the same signature against the reconstructed request, so message, tool, and stable-prefix changes still diverge.

Version 1 events upcast on read with `requestParametersHash: null` and retain their original full-request hash verification. Their missing parameters cannot be recovered, so previously tokenized v1 recordings may still diverge. Upcasting does not rewrite stored events or bypass hash checks.

## Updating the fixture

When an intentional behavior change affects the golden replay:

1. Run `yarn replay:update`.
2. Review the content-free `signature.json` and synthetic `cassette.json` changes.
3. Explain the behavior change in the pull request description and check the replay-regression item in the PR template.

`yarn replay:record` creates the initial fixture. `yarn replay:update` is an explicit update command and refuses to run when `CI=1` unless invoked with `--force-in-ci`. The gates job never updates the fixture. The mutation test reverses the scripted tool-call order and requires the gate to return behavioral-difference exit code `1`.
