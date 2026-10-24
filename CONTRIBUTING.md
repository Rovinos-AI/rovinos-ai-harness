# Contributing

Thanks for helping improve Rovinos AI Harness. Before proposing a change, read
the [engineering conventions](docs/engineering/CONVENTIONS.md) and the
applicable task specification in [`docs/engineering/tasks/`](docs/engineering/tasks/README.md)
or beside the code it describes.

## Prerequisites and setup

Install Node.js 26 and Yarn 4 using the repository's pinned toolchain:

```sh
mise trust
mise install
yarn install --immutable
```

Docker with Compose v2 is required for the integration tests.

## Workflow

Work on one task ID per pull request. Find task IDs in
[`docs/engineering/tasks/README.md`](docs/engineering/tasks/README.md), then read
the task spec and the nearest `AGENTS.md` before editing. Use the title format
`[<task id>] <task name>`. Add the task's progress marker as described in the
repository instructions.

Keep changes focused, include tests for behavior changes, and update relevant
documentation. Follow the code and privacy conventions in
[`docs/engineering/CONVENTIONS.md`](docs/engineering/CONVENTIONS.md).

## DCO sign-off

Every commit must include a Developer Certificate of Origin sign-off. Create
each commit with `-s`, for example:

```sh
git commit -s -m "Describe the change"
```

For an existing unsigned commit, add the sign-off with
`git commit --amend -s`. Azure Pipelines checks commit sign-offs before merge.

## Local checks

Run these checks before opening a pull request:

```sh
yarn lint
yarn test:unit
yarn check:spdx
```

Integration tests require Docker and the test Compose services. From the
repository root, start the test stack and run the integration suite:

```sh
scripts/ci/compose-wait.sh
COMPOSE_PROJECT_NAME=harness-local yarn test:integration
COMPOSE_PROJECT_NAME=harness-local docker compose --env-file infra/collector/VERSION -f infra/compose/docker-compose.test.yml down -v --remove-orphans
```

The `Rovinos AI Harness CI` Azure Pipeline gates merges: static checks run
before unit tests, then integration tests, then canary and replay gates. A
release stage runs only for tags.

## Proposing changes to guarantees

Changes to privacy, security, sandbox, or telemetry guarantees need evidence
and an explicit review. Update the guarantees and limits documentation in task
21.8 and add or update the relevant canary scenarios. Do not describe a
best-effort measure as a guarantee.
