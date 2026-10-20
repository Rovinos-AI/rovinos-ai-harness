# Quickstart

Run the harness locally with Docker Compose, a scripted model, and no provider API key. The sample
uses synthetic input and requests approval before writing a file in the run's isolated workspace.

## Prerequisites

- Docker Engine or Docker Desktop with Compose v2.
- A POSIX-compatible shell.

The first setup builds the harness and sandbox-runner images locally. The generated encryption key
is stored in the ignored `examples/quickstart/.env` file. Control-plane and sandbox-runner tokens
are generated inside the stack and kept in a named volume with per-service ownership and `0400`
permissions; you do not need to create or handle token files.

## Command helpers

The commands below assume you are running them from the repository root.

<!-- test:prelude -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
```

## Prepare the environment

<!-- test:run -->

```bash
cp examples/quickstart/.env.example examples/quickstart/.env
compose build harness sandbox-runner
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

## Start the stack

<!-- test:run -->

```bash
compose up -d --wait
```

The quickstart does not expose the HTTP control-plane endpoint; its commands use the CLI through
Compose. For remote HTTP access, configure TLS as described in
[Control-plane security](control-plane-security.md).

## Run and inspect the sample

Exit code `5` means the run is suspended while waiting for human approval.

<!-- capture:runId=(?<runId>[0-9A-HJKMNP-TV-Z]{26}) -->
<!-- test:expect-exit=5 -->
<!-- test:run -->

```bash
harness run --input examples/quickstart/task.json --fake-model examples/quickstart/fake-model.script.json
```

<!-- test:run -->

```bash
harness inspect <runId>
```

## Review and approve the requested write

The model's `fs.write` request is held for human review by the example policy. It is not executed
until the approval is recorded.

<!-- capture:approvalId="approvalId"\s*:\s*"(?<approvalId>[0-9A-HJKMNP-TV-Z]{26})" -->

<!-- test:run -->

```bash
harness --json approvals list
```

<!-- test:run -->

```bash
harness approvals approve <approvalId> --yes
```

## Resume the run

The second scripted completion lets the resumed run finish without configuring a real model
provider.

<!-- test:run -->

```bash
harness resume <runId> --fake-model examples/quickstart/resume-model.script.json
```

## Using a real provider

The fake model needs no API key. To route runs to a real provider instead, configure an API key using
a `SecretRef` and add a provider route in `harness.config.yaml`:

```yaml
models:
  providers:
    - id: openai
      kind: openai
      apiKey: env:OPENAI_API_KEY
  routing:
    default:
      - provider: openai
        model: gpt-4o-mini
```

Supply `OPENAI_API_KEY` through your environment or secret manager; do not place its value in the
configuration file. See [Secret references](secrets.md) for supported references and key handling.

## Stop and clean up

<!-- test:cleanup -->

```bash
if [ -f examples/quickstart/.env ]; then
  compose down --volumes --remove-orphans
fi
rm -f examples/quickstart/.env examples/quickstart/.env.tmp
```
