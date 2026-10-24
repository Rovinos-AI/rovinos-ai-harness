# Engineering task specifications

This folder contains the shared
[engineering conventions](CONVENTIONS.md) and the task index at
[`tasks/README.md`](tasks/README.md). Read the conventions before implementing
a task.

Task specifications live beside the code they describe. Foundation tasks are
in [`tasks/`](tasks/); other task specs are in the relevant package, `docs/`,
or `security/` directory. The task index links to each epic spec. The epic
specs describe task IDs, inputs, outputs, implementation guidance, tests, and
acceptance criteria.

Work on one task ID per pull request. Follow the nearest `AGENTS.md` as well as
the root instructions, and record completed tasks in `docs/progress.json` and
with the required marker in `docs/progress/<task-id>`.
