# Model roles

Roles bind a model-routing key to system instructions, a tool subset, budgets,
and an optional context strategy or result schema. The configuration is a list
of role objects because each role has a stable `id`:

```yaml
roles:
  - id: planner
    route: planner
    systemPrompt: "Create a short plan before delegating work."
    tools:
      - plan.*
    budgets:
      maxSteps: 40
      maxCostUsd: 2
      maxWallClockMs: 600000
    contextStrategy: sliding_window
    maxDepth: 2
    maxChildren: 8
```

An explicitly configured `route` must exist as a key in
`models.routing.roles`. When omitted, the model gateway uses
`models.routing.default`. A route may refer to an ordered list of model
references, as described in [Configuration](./configuration.md).

`tools` is either `"*"` or a list of tool IDs and `*` patterns such as
`fs.*`. Patterns with no registered tool generate the
`role_tool_pattern_unmatched` startup warning. `judge` and `summarizer` have
empty tool sets by default; `planner` and `worker` include all registered
tools. Configured role entries replace the matching built-in definition and
leave other built-ins unchanged.

Built-in roles are `planner`, `worker`, `judge`, and `summarizer`. Optional
`budgets.maxSteps`, `budgets.maxCostUsd`, and `budgets.maxWallClockMs` are
positive limits. `maxDepth` defaults to `2`; `maxChildren` defaults to `8`.
The optional `systemPrompt` is either text (up to 8,000 characters) or a file
reference such as `{ file: "relative/path.md" }` (whose contents are subject to
the same limit). Prompt files are loaded during startup and must resolve within
the config directory, including through symlinks.
Operator-authored prompt text is trusted instruction content and is recorded
in `model_request` events when sent to a model.

Roles are validated and prompt files resolved during runtime startup, using
the selected config directory and registered tools and context strategies.

The built-in `agent.spawn` tool creates a separate child run for a selected
role. Child runs receive their own event log and context, share the root run's
vault scope, and can use only tools present in both the parent registry and the
selected role's tool set. The tool is non-idempotent; the default example policy
asks for human approval.

An optional `resultSchema` is a module reference of the form
`"./schemas/result.js#ResultSchema"` or `"package-name#ResultSchema"`. Startup
fails if the module cannot be loaded or the named export is not a Zod schema.
Schemas from another Zod module copy are accepted when they expose Zod's
`safeParse` and `_zod` members.
An optional `contextStrategy` must name a strategy in the runtime registry.

See the configuration schema for the exact accepted fields and validation.
