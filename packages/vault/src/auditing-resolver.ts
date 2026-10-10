// SPDX-License-Identifier: Apache-2.0
import type { Code, Event, Id } from "@harness/schemas";
import type { Token } from "./token.js";
import { tokenType } from "./token.js";
import {
  VaultAuditSchema,
  VaultResolveContextSchema,
  type VaultAudit,
  type VaultResolver,
  type VaultResolveContext,
} from "./types.js";

/** Receives a metadata-only record for each detokenization action. */
export type VaultAuditHandler = (audit: VaultAudit) => Promise<void> | void;

/** Adds metadata-only audit records to a vault resolver. */
export class AuditingVaultResolver implements VaultResolver {
  /**
   * Create a resolver that audits successful and unknown-token resolutions.
   *
   * @param inner Resolver used to look up token values.
   * @param onAudit Handler that records metadata without receiving token values.
   */
  constructor(
    private readonly inner: VaultResolver,
    private readonly onAudit: VaultAuditHandler,
  ) {}

  /**
   * Resolve and audit a single token.
   *
   * @param runId Run that owns the token.
   * @param token Token to resolve.
   * @param context Boundary and optional tool identity for the resolution.
   * @returns The original value, or undefined when unknown.
   */
  async resolve(
    runId: Id,
    token: Token,
    context: VaultResolveContext,
  ): Promise<string | undefined> {
    const [value] = await this.resolveMany(runId, [token], context);
    return value;
  }

  /**
   * Resolve tokens and aggregate audit counts by entity type and outcome.
   *
   * @param runId Run that owns the tokens.
   * @param tokens Tokens to resolve.
   * @param context Boundary and optional tool identity for the resolutions.
   * @returns Values in the same order as the tokens, with undefined for unknown tokens.
   */
  async resolveMany(
    runId: Id,
    tokens: readonly Token[],
    context: VaultResolveContext,
  ): Promise<(string | undefined)[]> {
    const validatedContext = VaultResolveContextSchema.parse(context);
    const values: (string | undefined)[] = [];
    const counts = new Map<VaultAudit["action"], Map<Code, number>>();
    let resolutionFailed = false;
    let resolutionFailure: unknown;

    for (const token of tokens) {
      try {
        const value = await this.inner.resolve(runId, token, validatedContext);
        values.push(value);
        const action = value === undefined ? "blocked" : "detokenized";
        const type = tokenType(token).toLowerCase();
        const actionCounts = counts.get(action) ?? new Map<Code, number>();
        actionCounts.set(type, (actionCounts.get(type) ?? 0) + 1);
        counts.set(action, actionCounts);
      } catch (error) {
        values.push(undefined);
        const type = tokenType(token).toLowerCase();
        const actionCounts = counts.get("blocked") ?? new Map<Code, number>();
        actionCounts.set(type, (actionCounts.get(type) ?? 0) + 1);
        counts.set("blocked", actionCounts);
        if (!resolutionFailed) {
          resolutionFailure = error;
          resolutionFailed = true;
        }
      }
    }

    const auditRecords = [...counts].map(([action, entityCounts]) =>
      VaultAuditSchema.parse({
        runId,
        boundary: validatedContext.boundary,
        action,
        ...(validatedContext.toolId === undefined ? {} : { toolId: validatedContext.toolId }),
        entities: [...entityCounts].map(([type, count]) => ({ type, count })),
      }),
    );
    await Promise.all(auditRecords.map((audit) => Promise.resolve(this.onAudit(audit))));

    if (resolutionFailed) {
      throw resolutionFailure;
    }

    return values;
  }
}

/** Pii-action event fields ready to pass to the run recorder. */
export type VaultAuditPiiAction = Pick<
  Extract<Event, { type: "pii_action" }>,
  "type" | "action" | "boundary" | "toolId" | "entities"
>;

/**
 * Convert a validated vault audit into the payload fields recorded as a `pii_action`.
 *
 * @param audit - Metadata-only audit emitted by {@link AuditingVaultResolver}.
 * @returns Event fields without recorder-assigned envelope metadata.
 */
export function vaultAuditToPiiAction(audit: VaultAudit): VaultAuditPiiAction {
  return {
    type: "pii_action",
    action: audit.action,
    boundary: audit.boundary,
    ...(audit.toolId === undefined ? {} : { toolId: audit.toolId }),
    entities: audit.entities,
  };
}
