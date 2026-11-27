# Eval CI

The GitHub Actions workflow at
[`/.github/workflows/eval-nightly.yml`](../.github/workflows/eval-nightly.yml) replays
the synthetic suite in [`examples/evals/suite.ts`](../examples/evals/suite.ts)
from committed cassettes at 03:00 UTC each day. It also supports manual dispatch
on `main`, checks the report against `evals/baseline.json`, and uploads only the
metadata-only `eval-report.json` as an artifact.

The workflow requires no Azure resources, credentials, or write permissions. It
does not run live-model evaluations or record Docker cassettes.

## Baseline checks

`harness eval check-baseline <report> [--baseline <file>] [--max-drop <rate>]`
compares task/variant pass rates against the accepted baseline. The baseline
defaults to `evals/baseline.json`; the maximum allowed pass-rate drop defaults to
`0.05`. Drops beyond the threshold, removed task/variant pairs, and missing or
failed previously passing `no_canary_leak` or `trajectory` graders fail the
command. New task/variant pairs are allowed.

To prepare a candidate baseline, build the workspace, replay the suite, and
update a temporary baseline:

Build first with `yarn build`.

<!-- test:cleanup -->

```bash
rm -rf .tmp/evals-ci-report .tmp/evals-ci-baseline.json
```

<!-- test:run -->

```sh
node packages/cli/dist/bin.js eval run examples/evals/suite.ts --cassette replay --isolation inprocess --out .tmp/evals-ci-report
```

<!-- test:run -->

```sh
node packages/cli/dist/bin.js eval baseline update .tmp/evals-ci-report/eval-report.json --baseline .tmp/evals-ci-baseline.json
```

<!-- test:run -->

```sh
node packages/cli/dist/bin.js eval check-baseline .tmp/evals-ci-report/eval-report.json --baseline .tmp/evals-ci-baseline.json --max-drop 0.05
```

<!-- test:cleanup -->

```bash
rm -rf .tmp/evals-ci-report .tmp/evals-ci-baseline.json
```

Review the report and candidate baseline, then use
`harness eval baseline update <report>` to update the committed
`evals/baseline.json` in a dedicated PR. The baseline stores only aggregate
metrics and passing privacy-grader identities, not trial data.
