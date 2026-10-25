// SPDX-License-Identifier: Apache-2.0
import { Id, type Id as RunId } from "@rovinos/schemas";
import { InvalidEventError } from "./errors.js";
import {
  IdempotencyKeyHashSchema,
  type IdempotencyKeyHash,
  type IdempotencyKeyTakeoverOptions,
} from "./types.js";

/** Validated idempotency claim takeover fields used by store adapters. */
export interface ValidatedIdempotencyKeyTakeover {
  readonly keyHash: IdempotencyKeyHash;
  readonly expectedRunId: RunId;
  readonly runId: RunId;
  readonly createdAt: number;
  readonly staleBefore: number;
}

/**
 * Validate the fields for an idempotency-key takeover at the store boundary.
 * @param keyHash Digest associated with the key.
 * @param options Expected owner and replacement claim metadata.
 * @returns Parsed identifiers and validated timestamps.
 */
export function parseIdempotencyKeyTakeover(
  keyHash: IdempotencyKeyHash,
  options: IdempotencyKeyTakeoverOptions,
): ValidatedIdempotencyKeyTakeover {
  const parsedHash = IdempotencyKeyHashSchema.safeParse(keyHash);
  const parsedExpectedRunId = Id.safeParse(options.expectedRunId);
  const parsedRunId = Id.safeParse(options.runId);
  if (!parsedHash.success || !parsedExpectedRunId.success || !parsedRunId.success) {
    throw new InvalidEventError([["idempotencyKey"]]);
  }
  if (
    !Number.isSafeInteger(options.createdAt) ||
    options.createdAt < 0 ||
    !Number.isSafeInteger(options.staleBefore)
  ) {
    throw new InvalidEventError([["createdAt"]]);
  }
  return {
    keyHash: parsedHash.data,
    expectedRunId: parsedExpectedRunId.data,
    runId: parsedRunId.data,
    createdAt: options.createdAt,
    staleBefore: options.staleBefore,
  };
}

/** Stored claim metadata used by the in-memory adapter. */
export interface MemoryIdempotencyClaim {
  readonly runId: RunId;
  readonly createdAt: number;
}

/**
 * Claim a hashed idempotency key in memory.
 * @param claims Stored hash-to-claim mapping.
 * @param keyHash Digest associated with the key.
 * @param runId Candidate run identifier.
 * @param createdAt Claim time in epoch milliseconds.
 * @returns The candidate id or the id already associated with the key.
 */
export function claimMemoryIdempotencyKey(
  claims: Map<string, MemoryIdempotencyClaim>,
  keyHash: IdempotencyKeyHash,
  runId: RunId,
  createdAt: number,
): Promise<RunId> {
  const parsedHash = IdempotencyKeyHashSchema.safeParse(keyHash);
  const parsedRunId = Id.safeParse(runId);
  if (!parsedHash.success || !parsedRunId.success) {
    return Promise.reject(new InvalidEventError([["idempotencyKey"]]));
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    return Promise.reject(new InvalidEventError([["createdAt"]]));
  }
  const existingClaim = claims.get(parsedHash.data);
  if (existingClaim !== undefined) {
    return Promise.resolve(existingClaim.runId);
  }
  claims.set(parsedHash.data, { runId: parsedRunId.data, createdAt });
  return Promise.resolve(parsedRunId.data);
}

/**
 * Release an in-memory claim only when the run id still owns it.
 * @param claims Stored hash-to-claim mapping.
 * @param keyHash Digest associated with the key.
 * @param runId Run id expected to own the claim.
 * @returns A promise that resolves after the conditional release.
 */
export function releaseMemoryIdempotencyKey(
  claims: Map<string, MemoryIdempotencyClaim>,
  keyHash: IdempotencyKeyHash,
  runId: RunId,
): Promise<void> {
  const parsedHash = IdempotencyKeyHashSchema.safeParse(keyHash);
  const parsedRunId = Id.safeParse(runId);
  if (!parsedHash.success || !parsedRunId.success) {
    return Promise.reject(new InvalidEventError([["idempotencyKey"]]));
  }
  if (claims.get(parsedHash.data)?.runId === parsedRunId.data) {
    claims.delete(parsedHash.data);
  }
  return Promise.resolve();
}

/**
 * Remove all in-memory claims owned by a deleted run.
 * @param claims Stored hash-to-claim mapping.
 * @param runId Deleted run identifier.
 */
export function deleteMemoryIdempotencyKeyClaims(
  claims: Map<string, MemoryIdempotencyClaim>,
  runId: RunId,
): void {
  for (const [keyHash, claim] of claims) {
    if (claim.runId === runId) {
      claims.delete(keyHash);
    }
  }
}

/**
 * Replace a stale in-memory claim only while it still has no events.
 * @param claims Stored hash-to-claim mapping.
 * @param runs Stored run identifiers.
 * @param keyHash Digest associated with the key.
 * @param options Expected owner and replacement claim metadata.
 * @returns True only when the expected claim was replaced.
 */
export function takeoverMemoryIdempotencyKey(
  claims: Map<string, MemoryIdempotencyClaim>,
  runs: ReadonlyMap<RunId, unknown>,
  keyHash: IdempotencyKeyHash,
  options: IdempotencyKeyTakeoverOptions,
): boolean {
  const takeover = parseIdempotencyKeyTakeover(keyHash, options);
  const claim = claims.get(takeover.keyHash);
  if (
    claim?.runId !== takeover.expectedRunId ||
    claim.createdAt > takeover.staleBefore ||
    runs.has(takeover.expectedRunId)
  ) {
    return false;
  }
  claims.set(takeover.keyHash, { runId: takeover.runId, createdAt: takeover.createdAt });
  return true;
}
