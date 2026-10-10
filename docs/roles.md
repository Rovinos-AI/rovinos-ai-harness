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

Each `route` (or, by default, the role's `id`) must exist as a key in
`models.routing.roles`. A route may refer to an ordered list of model
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
The optional `systemPrompt` is either text (up to 8,000 characters) or
`{ file: "relative/path.md" }`. Prompt files are loaded during startup and
must resolve within the config directory, including through symlinks.
Operator-authored prompt text is trusted instruction content and is recorded
in `model_request` events when sent to a model.

An optional `resultSchema` is a module reference of the form
`"./schemas/result.js#ResultSchema"` or `"package-name#ResultSchema"`. Startup
fails if the module cannot be loaded or the named export is not a Zod schema.
An optional `contextStrategy` must name a strategy in the runtime registry.

See the configuration schema for the exact accepted fields and validation.
