# Secret scanning

Pull request CI scans changes since `origin/main` with the pinned Gitleaks
container in [`scripts/security/secret-scan.sh`](../../scripts/security/secret-scan.sh).
The nightly workflow scans full Git history. Both scans use Gitleaks redaction,
write a redacted JSON report to `reports/security/gitleaks-report.json`, and
fail when a finding is present. CI uploads that report even when the scan fails.

The [`.gitleaks.toml`](../../.gitleaks.toml) extends Gitleaks' default rules with
rules for `HARNESS_MASTER_KEY` and Datadog API key assignments. Its allowlist is
limited to files under `__fixtures__`, `examples/`, the reserved `example.test`
domain, explicit `FAKE_` or `test_` values, and non-secret `akv://` references.
Fixture and example files must contain synthetic values only; do not put real
credentials in an allowlisted path.

Run `scripts/security/apply-github-security-settings.sh --dry-run` to review
the GitHub API requests. After reviewing them, run the script with `--apply`
from a configured `gh` CLI session to enable secret scanning, push protection,
Dependabot alerts and security updates, and private vulnerability reporting.

Secret scanning and push protection require GitHub Secret Protection (formerly
part of GitHub Advanced Security) for private and internal repositories. They
are available without charge for public repositories. Dependabot alerts and
security updates, along with private vulnerability reporting, are available
without a GitHub Advanced Security license and are enabled through separate
repository endpoints.

Known gaps: the scanner detects known credential formats and the project rules
listed above; it cannot identify every possible secret format. GitHub push
protection depends on repository eligibility, enabled settings, and GitHub's
detectors, so CI scanning remains enabled independently.
