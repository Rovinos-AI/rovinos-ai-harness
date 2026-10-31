# Red-team eval suite

`suite.ts` defines one trajectory-checked task per approval-bypass attack.
The response scripts in `cassettes/attacks.json` are synthetic and are parsed
with the cassette schema exported by `suite.ts`; they require no live model
provider or credentials.

The replay test validates that every case is present in the suite, carries both
approval-integrity graders, and expects a safe terminal run status. The
invariant unit tests separately exercise each event-log violation and its
negative control. See [`docs/security/redteam.md`](../../docs/security/redteam.md)
for scope, CI mapping, and known coverage limits.
