// SPDX-License-Identifier: Apache-2.0
import {
  DetectionSchema,
  PiiActionSummarySchema,
  PiiEntitySchema,
  type Code,
  type Destination,
  type Id,
  type JsonValue,
  type Message,
  type PiiAction,
  type PiiActionSummary,
  type PiiPolicy,
} from "@harness/schemas";
import { countPiiBlobHit } from "@harness/telemetry";
import { findTokens, tokenType, type AuditingVaultResolver, type Token } from "@harness/vault";
import { evaluatePiiPolicy } from "./policy.js";
import { detectOutsideTokenSpans } from "./tokenizer-helpers.js";
import { PiiBlobContainsPiiError, PiiBlockedError, PiiTokenizerError } from "./errors.js";
import { PiiTokenUnresolvableError } from "./detokenize.js";
import type { PiiDetectorRegistry, Tokenizer } from "./tokenizer.js";

/** Receives metadata-only summaries for durable model-input PII events. */
export type PiiActionRecorder = (summary: PiiActionSummary) => Promise<void>;

/** Dependencies shared by the model-input sanitizer and runtime PII boundary. */
export interface PiiMessageSanitizerDependencies {
  readonly tokenizer: Tokenizer;
  readonly detectors: PiiDetectorRegistry;
  readonly policy: PiiPolicy;
  readonly resolver: AuditingVaultResolver;
}

interface SanitizationContext {
  readonly runId: Id;
  readonly destination: Destination;
  readonly allowRaw: boolean;
  readonly recordPiiAction: PiiActionRecorder | undefined;
}

interface TokenAction {
  readonly token: Token;
  readonly action: PiiAction;
  readonly entity: Code;
}

/**
 * Applies destination policy to model messages immediately before each provider attempt.
 *
 * @param dependencies - Tokenizer, detectors, policy, and audited vault resolver.
 */
export class PiiMessageSanitizer {
  constructor(private readonly dependencies: PiiMessageSanitizerDependencies) {}

  /**
   * Returns detached, sanitized messages for one provider attempt.
   *
   * @param messages - Provider-neutral conversation messages.
   * @param target - Provider/model and its configured trust level.
   * @param runId - Run scope for created or resolved tokens.
   * @param recordPiiAction - Optional durable recorder for metadata-only summaries.
   * @returns Sanitized messages; opaque provider blobs are passed through byte-for-byte.
   */
  async sanitize(
    messages: Message[],
    target: { readonly provider: Code; readonly model: Code; readonly trust: "hosted" | "local" },
    runId: Id,
    recordPiiAction?: PiiActionRecorder,
  ): Promise<Message[]> {
    const context: SanitizationContext = {
      runId,
      destination: target.trust,
      allowRaw: target.trust === "local",
      recordPiiAction,
    };
    const sanitized: Message[] = [];
    for (const message of messages) {
      const parts: Message["parts"] = [];
      for (const part of message.parts) {
        if (part.type === "text") {
          parts.push({
            ...part,
            text: await this.sanitizeText(part.text, context),
          });
        } else if (part.type === "tool_result") {
          parts.push({
            ...part,
            result: await this.sanitizeJson(part.result, context),
          });
        } else if (part.type === "opaque") {
          await this.scanOpaque(part.blob);
          parts.push(part);
        } else {
          parts.push(part);
        }
      }
      sanitized.push({ role: message.role, parts });
    }
    return sanitized;
  }

  private async sanitizeText(text: string, context: SanitizationContext): Promise<string> {
    let tokenized;
    try {
      tokenized = await this.dependencies.tokenizer.tokenizeText(context.runId, text, {
        boundary: "model_input",
        destination: context.destination,
        allowRaw: context.allowRaw,
      });
    } catch (error) {
      await this.recordBlock(error, context);
      throw error;
    }
    await this.recordSummaries(tokenized.actions, context);
    return this.applyTokenPolicy(
      tokenized.text,
      findTokens(text).map(({ token }) => token),
      context,
    );
  }

  private async sanitizeJson(value: JsonValue, context: SanitizationContext): Promise<JsonValue> {
    let tokenized;
    try {
      tokenized = await this.dependencies.tokenizer.tokenizeJson(context.runId, value, {
        boundary: "model_input",
        destination: context.destination,
        allowRaw: context.allowRaw,
      });
    } catch (error) {
      await this.recordBlock(error, context);
      throw error;
    }
    await this.recordSummaries(tokenized.actions, context);
    await this.recordSummaries(
      summarizeTokenActions(this.tokenActions(collectTokens(value), context.destination)),
      context,
    );
    return this.mapJsonStrings(tokenized.value, async (text) =>
      this.applyTokenPolicy(text, [], context),
    );
  }

  private async applyTokenPolicy(
    text: string,
    originalTokens: readonly Token[],
    context: SanitizationContext,
  ): Promise<string> {
    const matches = findTokens(text);
    if (matches.length === 0) {
      return text;
    }
    const decisions = matches.map(({ token }) => this.tokenAction(token, context.destination));
    await this.recordOriginalTokenActions(originalTokens, context);
    const blocked = new Map<Code, number>();
    for (const decision of decisions) {
      if (decision?.action === "block") {
        blocked.set(decision.entity, (blocked.get(decision.entity) ?? 0) + 1);
      }
    }
    if (blocked.size > 0) {
      throw new PiiBlockedError([...blocked].map(([type, count]) => ({ type, count })));
    }
    const resolved = await this.resolveAllowedTokens(matches, decisions, context);
    return this.renderTokens(text, { matches, decisions, resolved }, context);
  }

  private async recordOriginalTokenActions(
    tokens: readonly Token[],
    context: SanitizationContext,
  ): Promise<void> {
    const originalDecisions = tokens
      .map((token) => this.tokenAction(token, context.destination))
      .filter((decision): decision is TokenAction => decision !== undefined);
    const summaryCounts = new Map<PiiAction, Map<Code, number>>();
    for (const decision of originalDecisions) {
      addCount(summaryCounts, decision.action, decision.entity);
    }
    await this.recordSummaries(summarizeTokenActions(summaryCounts), context);
  }

  private async resolveAllowedTokens(
    matches: ReturnType<typeof findTokens>,
    decisions: readonly (TokenAction | undefined)[],
    context: SanitizationContext,
  ): Promise<(string | undefined)[]> {
    const allowedTokens = context.allowRaw
      ? matches.flatMap(({ token }, index) => (decisions[index]?.action === "allow" ? [token] : []))
      : [];
    if (allowedTokens.length > 0) {
      try {
        const resolved = await this.dependencies.resolver.resolveMany(
          context.runId,
          allowedTokens,
          { boundary: "model_input" },
        );
        if (resolved.some((value) => value === undefined)) {
          throw new PiiTokenUnresolvableError();
        }
        return resolved;
      } catch (error) {
        if (error instanceof PiiTokenUnresolvableError) {
          throw error;
        }
        throw new PiiTokenizerError("pii_vault_failed");
      }
    }
    return [];
  }

  private renderTokens(
    text: string,
    tokens: {
      readonly matches: ReturnType<typeof findTokens>;
      readonly decisions: readonly (TokenAction | undefined)[];
      readonly resolved: readonly (string | undefined)[];
    },
    context: SanitizationContext,
  ): string {
    const { matches, decisions, resolved } = tokens;
    let output = "";
    let offset = 0;
    let resolvedIndex = 0;
    for (const [index, match] of matches.entries()) {
      output += text.slice(offset, match.index);
      const decision = decisions[index];
      if (decision?.action === "redact") {
        output += `[REDACTED:${decision.entity}]`;
      } else if (decision?.action === "allow" && context.allowRaw) {
        const raw = resolved[resolvedIndex];
        if (raw === undefined) {
          throw new PiiTokenUnresolvableError();
        }
        output += raw;
        resolvedIndex += 1;
      } else {
        output += match.token;
      }
      offset = match.index + match.token.length;
    }
    return output + text.slice(offset);
  }

  private tokenAction(token: Token, destination: Destination): TokenAction | undefined {
    const entity = PiiEntitySchema.safeParse(tokenType(token).toLowerCase());
    if (!entity.success) {
      return undefined;
    }
    const policyAction = evaluatePiiPolicy(this.dependencies.policy, {
      entity: entity.data,
      boundary: "model_input",
      destination,
    });
    return {
      token,
      entity: entity.data,
      action: destination === "hosted" && policyAction === "allow" ? "tokenize" : policyAction,
    };
  }

  private tokenActions(
    tokens: readonly Token[],
    destination: Destination,
  ): Map<PiiAction, Map<Code, number>> {
    const counts = new Map<PiiAction, Map<Code, number>>();
    for (const token of tokens) {
      const decision = this.tokenAction(token, destination);
      if (decision !== undefined) {
        addCount(counts, decision.action, decision.entity);
      }
    }
    return counts;
  }

  private async mapJsonStrings(
    value: JsonValue,
    transform: (text: string) => Promise<string>,
  ): Promise<JsonValue> {
    if (typeof value === "string") {
      return transform(value);
    }
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const child of value) {
        result.push(await this.mapJsonStrings(child, transform));
      }
      return result;
    }
    if (value !== null && typeof value === "object") {
      const entries: [string, JsonValue][] = [];
      const keys = new Set<string>();
      for (const [key, child] of Object.entries(value)) {
        const transformedKey = await transform(key);
        if (keys.has(transformedKey)) {
          throw new PiiTokenizerError("pii_input_invalid");
        }
        keys.add(transformedKey);
        entries.push([transformedKey, await this.mapJsonStrings(child, transform)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  }

  private async recordSummaries(
    summaries: readonly PiiActionSummary[],
    context: SanitizationContext,
  ): Promise<void> {
    for (const summary of summaries) {
      await context.recordPiiAction?.(PiiActionSummarySchema.parse(summary));
    }
  }

  private async recordBlock(error: unknown, context: SanitizationContext): Promise<void> {
    if (error instanceof PiiBlockedError) {
      await this.recordSummaries(
        [{ boundary: "model_input", action: "block", entities: [...error.entities] }],
        context,
      );
    }
  }

  private async scanOpaque(value: JsonValue): Promise<void> {
    const strings: string[] = [];
    collectStrings(value, strings);
    for (const text of strings) {
      const detections = await detectOutsideTokenSpans(text, async (masked) => {
        const detected = await this.dependencies.detectors.detect(masked);
        return detected.map((detection) => DetectionSchema.parse(detection));
      });
      if (detections.length > 0) {
        countPiiBlobHit();
        throw new PiiBlobContainsPiiError();
      }
    }
  }
}

function addCount(
  counts: Map<PiiAction, Map<Code, number>>,
  action: PiiAction,
  entity: Code,
): void {
  const entities = counts.get(action) ?? new Map<Code, number>();
  entities.set(entity, (entities.get(entity) ?? 0) + 1);
  counts.set(action, entities);
}

function summarizeTokenActions(
  counts: ReadonlyMap<PiiAction, ReadonlyMap<Code, number>>,
): PiiActionSummary[] {
  return [...counts].map(([action, entities]) => ({
    boundary: "model_input",
    action,
    entities: [...entities].map(([type, count]) => ({ type, count })),
  }));
}

function collectStrings(value: JsonValue, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const child of value) {
      collectStrings(child, output);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.push(key);
      collectStrings(child, output);
    }
  }
}

function collectTokens(value: JsonValue, output: Token[] = []): Token[] {
  if (typeof value === "string") {
    output.push(...findTokens(value).map(({ token }) => token));
  } else if (Array.isArray(value)) {
    for (const child of value) {
      collectTokens(child, output);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.push(...findTokens(key).map(({ token }) => token));
      collectTokens(child, output);
    }
  }
  return output;
}
