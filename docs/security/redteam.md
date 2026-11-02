# Red-team coverage

## MCP tool-name aliases

MCP servers are untrusted. The registry only exposes a native tool when
normalizing its name would leave that name unchanged. A non-canonical name is
rejected with `tool_name_invalid` before it can become a model-visible tool or
an execution route.

The replay regression in
[`test/replay/redteam.attacks.replay.test.ts`](../../test/replay/redteam.attacks.replay.test.ts)
advertises `exec` alongside a trailing-space alias and a Cyrillic look-alike.
It checks the policy combination that denies `sandbox.exec` and allows
`sandbox.*`: the wildcard would allow the alias if it were registered, but the
registry rejects it and the MCP server receives no call. This closes the
look-alike registration gap for server-advertised names.

Canonical-name enforcement is a compatibility change. Names that previously
relied on lowercasing, character replacement, or underscore collapsing (for
example `Get-Thing`, a name with a trailing space, or `two__underscores`) are
no longer available until the server advertises canonical native names.
