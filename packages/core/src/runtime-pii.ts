// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { Code, SpanId, TraceId, type PiiConfig } from "@harness/schemas";
import {
  creditCardDetector,
  createCustomDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  Tokenizer,
  urlCredentialsDetector,
  type Detector,
} from "@harness/pii";
import {
  AuditingVaultResolver,
  type VaultScopeResolver,
  type VaultResolver,
  type VaultWriter,
} from "@harness/vault";
import { emitSafeEvent, SafeEvent } from "@harness/telemetry";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { Clock } from "./recorder.js";

const vaultAuditLogger = logs.getLogger("@harness/core");
const fallbackTraceId = TraceId.parse("1".repeat(32));
const fallbackSpanId = SpanId.parse("2".repeat(16));

const builtInDetectors: readonly Detector[] = [
  creditCardDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  urlCredentialsDetector,
];

/** Builds the PII dependencies shared by the runtime's tool and storage boundaries. */
export function createRuntimePii(
  config: PiiConfig,
  vault: VaultWriter & VaultResolver,
  scopes: RunScopeRegistry,
  scopeOf: VaultScopeResolver,
  policyVersion: Code,
  clock: Clock,
): { readonly tokenizer: Tokenizer; readonly resolver: AuditingVaultResolver } {
  const detectors = [
    ...builtInDetectors,
    ...(config.custom ?? []).map((detector) => createCustomDetector(detector)),
  ];
  const tokenizer = new Tokenizer({
    detectors: {
      detect: (text) => detectors.flatMap((detector) => detector.detect(text)),
    },
    policy: config,
    vault,
    scopeOf: scopes.scopeOf,
  });
  const resolver = new AuditingVaultResolver(
    vault,
    (audit) => {
      const spanContext = trace.getSpan(context.active())?.spanContext();
      emitSafeEvent(
        vaultAuditLogger,
        SafeEvent.parse({
          runId: audit.runId,
          seq: 0,
          ts: Math.max(0, Math.floor(clock.now())),
          traceId: spanContext?.traceId ?? fallbackTraceId,
          spanId: spanContext?.spanId ?? fallbackSpanId,
          policyVersion,
          kind: "pii_action",
          boundary: audit.boundary,
          action: audit.action,
          ...(audit.toolId === undefined ? {} : { toolId: audit.toolId }),
          entities: audit.entities,
        }),
      );
    },
    scopeOf,
  );
  return { tokenizer, resolver };
}
