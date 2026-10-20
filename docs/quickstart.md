# Quickstart

Run the harness locally with Docker Compose, a scripted model, and no provider API key. The sample
uses synthetic input and requests approval before writing a file in the run's isolated workspace.

## Prerequisites

- Docker Engine or Docker Desktop with Compose v2.
- A POSIX-compatible shell.

The first setup builds the harness image locally. Generated credentials are stored only in the
ignored `examples/quickstart/.env` and `examples/quickstart/.env.control-plane-token` files; do not
commit or share them.

## Prepare the environment

<!-- capture:runId=(?<runId>[0-9A-HJKMNP-TV-Z]{26}) -->
<!-- test:run -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
cp examples/quickstart/.env.example examples/quickstart/.env
cp test/fixtures/empty-secret examples/quickstart/.env.control-plane-token
if ! docker image inspect "${HARNESS_IMAGE:-harness:quickstart}" >/dev/null 2>&1; then
  compose build harness
fi
key="$(harness keys generate | sed -n '1p')"
control_token="$(harness keys generate | sed -n '1p')"
test -n "$key"
test -n "$control_token"
sed "s|^HARNESS_KEY=.*|HARNESS_KEY=$key|" examples/quickstart/.env > examples/quickstart/.env.tmp
chmod 600 examples/quickstart/.env.tmp
mv examples/quickstart/.env.tmp examples/quickstart/.env
printf '%s\n' "$control_token" > examples/quickstart/.env.control-plane-token
chmod 600 examples/quickstart/.env.control-plane-token
unset key control_token
```

## Start the stack

<!-- test:run -->

```bash
docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml up -d --wait
```

## Run and inspect the sample

<!-- test:run -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
if harness run --input examples/quickstart/task.json --fake-model examples/quickstart/fake-model.script.json; then
  exit 1
else
  status=$?
fi
test "$status" -eq 5
```

<!-- test:run -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
harness inspect <runId>
```

## Review and approve the requested write

The model's `fs.write` request is held for human review by the example policy. It is not executed
until the approval is recorded.

<!-- capture:approvalId="approvalId"\s*:\s*"(?<approvalId>[0-9A-HJKMNP-TV-Z]{26})" -->

<!-- test:run -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
harness --json approvals list
```

<!-- test:run -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
harness approvals approve <approvalId> --yes
```

## Resume the run

The second scripted completion lets the resumed run finish without configuring a real model provider.

<!-- test:run -->

```bash
set -euo pipefail
compose() { docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml "$@"; }
harness() { compose run --rm --no-deps harness "$@"; }
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
set -euo pipefail
if [ -f examples/quickstart/.env ]; then
  docker compose --env-file examples/quickstart/.env -f examples/quickstart/docker-compose.quickstart.yml down --volumes --remove-orphans
fi
rm -f examples/quickstart/.env examples/quickstart/.env.tmp
rm -f examples/quickstart/.env.control-plane-token
```
