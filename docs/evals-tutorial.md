<!-- SPDX-License-Identifier: Apache-2.0 -->
# Eval suite tutorial

The example suite at [`examples/evals`](../examples/evals/README.md) runs three synthetic tasks:
it repairs a fixture file, validates a structured answer with Zod, and checks privacy-related
trajectory assertions. Its committed cassettes are generated from scripted synthetic responses;
replay does not contact a model provider.

## Run and read the report

Build the CLI, then replay both variants from the repository root. This is the command the replay
gate executes through the documentation test runner:

<!-- test:cleanup -->

```bash
rm -rf .tmp/evals-tutorial
```

<!-- test:run -->

```bash
node packages/cli/dist/bin.js eval run examples/evals/suite.ts --cassette replay --variants examples/evals/variants.yaml --fail-under 1.0 --out .tmp/evals-tutorial
```

<!-- test:run -->

```bash
sed -n '1,80p' .tmp/evals-tutorial/eval-report.md
```

The report includes pass rates, cost and step counts. It contains grader codes and aggregate
metadata, not transcripts or task content.

## Add a grader

Each task lists graders in `examples/evals/suite.ts`. For example, add another
`{ type: "file_diff", path: "greeting.txt", expectedContains: "Hello harness." }` to the
`fix_greeting` task to add an independent check of the fixture edit. The
`structured-output` task points to `WeatherSchema` in `examples/evals/schemas.ts`; the
`protect_contact` task asserts that a synthetic PII canary is absent from model input and that the
`mail.send` tool is never called.

## Record a cassette with a real model

Live recording is optional and is never part of CI. To avoid overwriting the checked-in synthetic
cassettes, copy the suite to a temporary directory before recording. Use a provider and credentials
you have configured for the CLI, and review the generated files before retaining them:

```bash
recording_dir="$(mktemp -d)"
cp -R examples/evals/. "$recording_dir/"
node packages/cli/dist/bin.js eval run "$recording_dir/suite.ts" --cassette record --isolation inprocess --model openai/gpt-4o-mini --out "$recording_dir/out"
```

Do not commit a recording unless you have checked it contains only synthetic data and declares
`containsRealData: false`.

## Compare variants

`variants.yaml` defines `baseline` and `candidate`; the first replay command writes results for both.
Compare their results with the documented command below. This comparison command is also executed
by the replay gate:

<!-- test:run -->

```bash
node packages/cli/dist/bin.js eval compare .tmp/evals-tutorial/eval-report.json .tmp/evals-tutorial/eval-report.json --variant-a baseline --variant-b candidate --seed 41
```

Remove the local report when finished:

<!-- test:cleanup -->

```bash
rm -rf .tmp/evals-tutorial
```

## Decisions and verification

The task specification named the Azure nightly replay stage, which was retired; the example replay
now runs in the GitHub Actions `gates` job through `yarn test:replay`. The cassette directory follows
the current CLI implementation, `<suite directory>/cassettes/<taskId>/<variantId>.json`.
