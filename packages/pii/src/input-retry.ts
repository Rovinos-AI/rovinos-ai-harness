// SPDX-License-Identifier: Apache-2.0
import { JsonValue as JsonValueSchema, type Code, type InputResponse } from "@rovinos/schemas";
import { isToken, type AuditingVaultResolver } from "@rovinos/vault";
import { PiiTokenUnresolvableError } from "./detokenize.js";
import type { PiiToolContext } from "./pii-tool-port.js";
import { validateWithTokens } from "./validate-with-tokens.js";

/** Restores opaque input metadata and resolves human answers before a resumed tool call. */
export async function resolveInputRetry(
  context: PiiToolContext,
  retry: NonNullable<PiiToolContext["inputRetry"]>,
  resolver: AuditingVaultResolver,
  toolId: Code,
): Promise<NonNullable<PiiToolContext["inputRetry"]>> {
  const protectedKeys = Object.keys(retry.inputResponses);
  const protectedValues = [
    ...protectedKeys,
    ...(retry.requestState === undefined ? [] : [retry.requestState]),
  ];
  if (protectedValues.some((value) => !isToken(value))) {
    throw new PiiTokenUnresolvableError();
  }
  const resolvedValues = await resolver.resolveMany(
    context.runId,
    protectedValues.filter(isToken),
    { boundary: "tool_input", toolId },
    context.recordVaultAudit,
  );
  if (
    resolvedValues.length !== protectedValues.length ||
    resolvedValues.some((value) => value === undefined)
  ) {
    throw new PiiTokenUnresolvableError();
  }
  const rawValues = resolvedValues.map((value) => {
    if (value === undefined) {
      throw new PiiTokenUnresolvableError();
    }
    return value;
  });
  const rawKeys = rawValues.slice(0, protectedKeys.length).map(unwrapOpaqueInput);
  const requestState =
    retry.requestState === undefined
      ? undefined
      : unwrapOpaqueInput(rawValues[protectedKeys.length] ?? "");
  const responseEntries: [string, InputResponse][] = [];
  for (const [index, [, response]] of Object.entries(retry.inputResponses).entries()) {
    const inputKey = rawKeys[index];
    if (inputKey === undefined) {
      throw new PiiTokenUnresolvableError();
    }
    if (response.answer === undefined) {
      responseEntries.push([inputKey, response]);
      continue;
    }
    const resolved = await validateWithTokens(JsonValueSchema, response.answer, {
      runId: context.runId,
      resolver,
      wantRaw: true,
      toolId,
      ...(context.recordVaultAudit === undefined ? {} : { onAudit: context.recordVaultAudit }),
    });
    if (!resolved.ok || resolved.raw === undefined) {
      throw new PiiTokenUnresolvableError();
    }
    responseEntries.push([inputKey, { ...response, answer: resolved.raw }]);
  }
  const inputResponses = Object.fromEntries(responseEntries);
  return {
    ...retry,
    inputResponses,
    ...(requestState === undefined ? {} : { requestState }),
  };
}

function unwrapOpaqueInput(value: string): string {
  if (!value.startsWith("\u0000") || !value.endsWith("\u0000") || value.length < 2) {
    throw new PiiTokenUnresolvableError();
  }
  return value.slice(1, -1);
}
