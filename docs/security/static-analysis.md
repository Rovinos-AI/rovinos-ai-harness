# Static analysis

The `static` job runs Semgrep OSS `1.182.0`, pinned by image tag and digest, and
uploads the JSON result as the `semgrep-report` artifact. The scanner runs in a
separate Docker process. A temporary unsafe fixture is also scanned in CI; the
check fails unless Semgrep reports the expected rule finding.

## Rules

The rules in [`security/semgrep/`](../../security/semgrep/) cover shell
execution, dynamic evaluation, unsafe HTML sinks, unbounded server `fetch`
calls, weak random identifiers, deprecated cryptography, unchecked request
JSON, insecure HTTP URLs, and direct reads of secret-looking environment
variables.

Request-body validation and random-value rules are pattern-based heuristics.
The request-body rule detects selected `JSON.parse` forms unless they are
immediately nested in a Zod `.parse` or `.safeParse` call; it does not prove
validation across statements, aliases, helper functions, or control flow.
Use `parseJson(schema, text)` at request boundaries. The random-value rule
examines assignments to names containing `id`, `token`, or `key` in the
specified packages, and does not infer a value's later use.

The fetch rule checks calls with omitted options or a literal options object.
It recognizes signal properties, including conditional object spreads, but
does not inspect caller-supplied options variables. The environment rule only
checks direct `process.env` property access with secret-looking names; it does
not follow aliases. Dynamic URL construction is also outside the HTTP rule's
scope. The HTTP rule excludes the egress-proxy probe generator, whose
intentional HTTP requests are exercised by integration tests. The environment
rule allows the sandbox runner's `runnerTokenFromEnvironment` bootstrap
function; it validates the token and deletes the secret-bearing variables
before starting the server.

## Adding a rule

Add a YAML rule with a stable `id`, `severity: ERROR`, and a message that names
the safe alternative. Add `// ruleid: <rule-id>` and `// ok: <rule-id>`
examples under `security/semgrep/tests/`, then run:

```sh
scripts/security/semgrep.sh
```

The script runs the Semgrep rule tests, scans the repository into
`reports/semgrep.json`, and verifies a positive control.

## Suppressing a finding

Prefer fixing the unsafe pattern. If a reviewed exception is necessary, add a
specific Semgrep suppression and a concise reason:

```ts
// nosemgrep: harness.rule-id -- compatibility with the isolated test adapter
```

The `check:nosemgrep` lint step rejects a suppression without a rule id and a
non-empty reason after `--`. Keep suppressions narrow and include the reason
when proposing the change. The collector health probe in the CLI has one
documented suppression: the Compose health listener is HTTP-only and is
published to the host on loopback.

## Complementary GitHub scanning

Enable **CodeQL default setup** in the repository's GitHub security settings.
CodeQL complements these project-specific Semgrep rules; it does not replace
their fixtures or CI gate.
