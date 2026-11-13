# Optional extension roadmap

This roadmap records package boundaries and sequencing, not approval to add public APIs, publish
packages, or implement every candidate. Follow-up issues and package names require maintainer
authorization.

## Package and responsibility map

| Area | Decision | Package or integration boundary |
| --- | --- | --- |
| Memory and retrieval | Adopt optional adapters, starting with the bounded reference in #695. Defer database-specific backends until demand and lifecycle/security requirements are clear. | Keep retrieval implementations independently installed, such as the existing `@rovinos/extension-retrieval`. Do not add a vector database to core or `@rovinos/extensions`. |
| Skills and templates | Adopt a small, versioned content-loader scope with explicit requested tools and capabilities. | Optional helpers may live in `@rovinos/extensions`; content sources and executable implementations remain application-owned or separately installed. Loading content never grants its requests. |
| Schedules and webhooks | Adopt thin, authenticated, idempotent run-submission integrations. Exclude a full scheduler from core. | Keep ingress integrations in the application or independently installed adapters. They submit through governed SDK paths; run admission, budgets, and execution remain harness responsibilities. |
| Framework adapters | Adopt selectively, after public contracts are stable and the reference consumer journey is established. | Keep adapters independently installed. They must route effects through harness-controlled contracts rather than an ungoverned tool loop. |
| Hosted tenancy | Defer hosted administration and billing. | Do not claim multi-tenant support until principal identity, tenant scope, and isolation requirements are specified. Operational recovery remains a core/deployment responsibility. |
| Provider expansion | Defer new provider packages until current paths are reliable and demand justifies expansion. | If approved, install providers separately where dependency weight or release cadence warrants it; retain central SDK provider contracts and validation. |

Policy, privacy, approval integrity, durable execution, and enabled budget enforcement remain core
responsibilities. Optional extensions do not move or weaken these guarantees. A full scheduler,
vector database, and hosted administration/billing layer are not core additions.

## Contracts, capabilities, and trust

The SDK remains the contract owner and the only stable programmatic surface. The SDK validates
manifests, compatibility ranges, and registrations; the application explicitly imports and registers
trusted implementations. `@rovinos/extensions` is optional authoring help over those SDK contracts:
it cannot grant capabilities or load implementations. Concrete backend, provider, and framework
dependencies do not belong in that helper package.

Manifests describe requested capabilities; an operator grant is separate and only authorizes the
matching SDK-mediated contribution. The currently supported contribution grants are
`tools.contribute` and `providers.contribute`. Reserved or unsupported capabilities, including
`events.observe` and `content.read`, do not become usable merely by appearing in a manifest. New
SDK-mediated capabilities require a separately reviewed SDK contract and enforcement path before
implementation; an integration using an existing public SDK run-submission method does not require
a new capability merely because it submits a run.

Extension code is trusted application code. In-process validation governs mediated contributions;
it is not a sandbox and does not restrict ambient filesystem, network, or process access. Executable
skills or other untrusted implementations require an independently enforced process or container
boundary with explicit communication and egress policy. Tests of in-process contracts must not be
presented as isolation guarantees.

| Adopted area | Manifest or capability model | Trust boundary |
| --- | --- | --- |
| Memory and retrieval | An SDK extension requests only named `tools.contribute` targets; the operator grants them. Retrieval stays within the host-supplied corpus scope. | The reference is trusted in-process code. A remote or untrusted backend needs its own credential, egress, and isolation review. |
| Skills and templates | Versioned content is data, not authority. If an SDK extension contributes skill tools, its manifest requests those named tools; content cannot grant them or make unsupported `content.read` usable. | Treat loaded content as untrusted instructions. Executable skills require trusted-code review or a separately enforced service boundary. |
| Schedules and webhooks | Authenticate ingress and resolve its principal and allowed run scope at the integration boundary; use governed SDK run submission and idempotency. This ingress identity is not a manifest grant. | Validate authentication, scope, and replay at ingress. If packaged as an SDK extension, it remains trusted code unless separately isolated. |
| Framework adapters | Request only named `tools.contribute` or `providers.contribute` targets through the SDK manifest and require operator grants. | Trusted adapters route effects through SDK-controlled paths. Untrusted framework code needs separate process/container isolation. |

## Compatibility, dependencies, and replay

- Each independently installed implementation declares the SDK compatibility range it supports and
  tests its installed-package workflow against that range. SDK package versions, manifest schema
  versions, and persisted event/result schema versions remain distinct.
- Implementations depend on the public SDK contract; they depend on `@rovinos/extensions` only when
  using its helpers. The helper does not install concrete implementation dependencies transitively.
- Keep implementation packages independently versioned and releasable. Review compatibility and
  migration requirements when contracts or external state change; do not broaden an SDK range
  without compatibility tests.
- Replay consumes harness-recorded results and must not repeat extension callbacks or external
  effects. Any future stateful extension requires explicit lifecycle, upgrade, and recovery
  semantics before adoption.

## Sequencing and follow-up scope

The core correctness queue takes priority; optional expansion must not block it. The bounded
retrieval reference in #695 is the starting implementation, not a reason to create a second reference.
The following are proposed bounded scopes, not created or authorized follow-up issues:

1. **Retrieval backends:** only after demonstrated demand; scope one backend at a time, including
   retention/deletion, cancellation, credential/egress controls, and a permission-denial case.
2. **Skills/templates:** define versioned content loading and explicit capability requests; test an
   installed-package workflow, denial when no operator grant is supplied, and adversarial content that cannot
   acquire authority. Test executable content at its actual isolation boundary.
3. **Schedules/webhooks:** implement one thin ingress integration; test an installed-package
   workflow, authentication and scope denial, duplicate/idempotent submission, and spoofing or replay
   abuse. Do not add scheduling or execution authority to the integration.
4. **Framework adapters:** select an adapter only after demand and the public reference journey are
   clear; test an installed-package workflow, permission denial, and attempts to route effects
   outside harness-controlled tools. Test isolation separately if code is untrusted.

The existing retrieval workflow should continue to cover installed-package use, denied operations,
and scope/injection abuse. For every future adopted implementation, require the same three categories
of evidence: a public installed-package workflow, a permission-denial case, and an appropriate
abuse/isolation scenario. In-process tests establish contract behavior only, not sandboxing.

Hosted tenancy and provider expansion remain deferred pending their stated prerequisites; scope them
independently if maintainers later authorize that work.
