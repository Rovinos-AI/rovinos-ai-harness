# Security Policy

## Supported versions

The project has not published a stable release. Security fixes are made on the
latest `main` branch while the project is in pre-release development.

| Version | Supported |
| --- | --- |
| `main` (pre-release) | Yes |
| Published releases | None yet |

## Reporting

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/Rovinos-AI/rovinos-ai-harness/security/advisories/new).
Do not open a public issue for an unpatched vulnerability. Include a clear
description, impact, and minimal reproduction details; avoid real personal
data, credentials, or production secrets.

Maintainers will acknowledge reports within `<INITIAL_RESPONSE_TIME>` and
provide an assessment or remediation plan within `<FOLLOW_UP_TIME>`. These
response targets require maintainer confirmation.

## Scope and severity

A vulnerability is a defect that could compromise confidentiality, integrity,
or availability of the harness, its users, or their systems. This includes
authentication or authorization bypass, unsafe handling of untrusted input,
dependency or supply-chain compromise, and vulnerabilities in supported
deployment examples.

Any confirmed PII or telemetry leakage, and any sandbox escape, is high
severity. Include these details only in a private report.

## Coordinated disclosure

Please give maintainers a reasonable opportunity to investigate and prepare a
fix before public disclosure. Coordinate the disclosure date and any advisory
with maintainers. Do not publish exploit details or user data while a report is
being investigated. We will credit reporters when they want attribution and it
is safe to do so.

## Compliance

The project provides no compliance certification and does not certify that a
deployment meets any regulatory or legal requirement. See
[guarantees and known limits](docs/guarantees.md) for project assumptions and
known gaps.
