# Approval flow

From the repository root, run the synthetic quickstart scenario. It uses a scripted fake model and
reuses the secure Compose stack and fixtures from `examples/quickstart`:

<!-- test:prelude -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
```

<!-- test:run -->

```bash
cp examples/quickstart/.env.example examples/quickstart/.env
compose build harness
compose build sandbox-runner
key="$(harness keys generate | sed -n '1p')"
test -n "$key"
while IFS= read -r line; do
  if [[ "$line" == HARNESS_KEY=* ]]; then
    printf 'HARNESS_KEY=%s\n' "$key"
  else
    printf '%s\n' "$line"
  fi
done < examples/quickstart/.env > examples/quickstart/.env.tmp
chmod 600 examples/quickstart/.env.tmp
mv examples/quickstart/.env.tmp examples/quickstart/.env
unset key
```

<!-- test:run -->

```bash
compose up -d --wait
```

<!-- capture:runId=(?<runId>[0-9A-HJKMNP-TV-Z]{26}) -->
<!-- test:expect-exit=5 -->
<!-- test:run -->

```bash
harness run --input examples/quickstart/task.json --fake-model examples/quickstart/fake-model.script.json
```

The expected exit code is `5`: the policy's `ask` rule suspends the run before the file-write tool
executes.

<!-- capture:approvalId="approvalId"\s*:\s*"(?<approvalId>[0-9A-HJKMNP-TV-Z]{26})" -->
<!-- test:run -->

```bash
harness --json approvals list
```

<!-- test:run -->

```bash
harness approvals approve <approvalId> --yes
```

<!-- test:run -->

```bash
harness resume <runId> --fake-model examples/quickstart/resume-model.script.json
```

Expected output from the final inspect:

```text
status: completed
```

<!-- test:run -->

```bash
harness inspect <runId>
```

<!-- test:cleanup -->

```bash
if [ -f examples/quickstart/.env ]; then
  compose down --volumes --remove-orphans
fi
rm -f examples/quickstart/.env examples/quickstart/.env.tmp
```
