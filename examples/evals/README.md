# Example eval suite

This runnable suite demonstrates a fixture-backed file edit, schema-validated extraction, and
privacy trajectory assertions. Every task and cassette uses synthetic data.

From the repository root, build the CLI and run the [eval tutorial](../../docs/evals-tutorial.md):

```bash
yarn build
node packages/cli/dist/bin.js eval run examples/evals/suite.ts --cassette replay --variants examples/evals/variants.yaml --fail-under 1.0 --out .tmp/evals-tutorial
```

The replay files live at `cassettes/<taskId>/<variantId>.json`. Each cassette declares
`containsRealData: false`; the replay test also scans the stored responses for PII-like values.
