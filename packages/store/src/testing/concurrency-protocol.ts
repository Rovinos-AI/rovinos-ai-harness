// SPDX-License-Identifier: Apache-2.0
import { Id } from "@harness/schemas";
import { z } from "zod";

const workerIndexSchema = z.union([z.literal(0), z.literal(1)]);
const requestIdSchema = z.number().int().positive();
const workerResponseValueSchema = z.union([
  z.boolean(),
  z.number().int().nonnegative(),
  z.object({ nextSeq: z.number().int().nonnegative() }).strict(),
]);

export const workerResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      kind: z.literal("result"),
      workerIndex: workerIndexSchema,
      outcome: z.literal("fulfilled"),
      nextSeq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      workerIndex: workerIndexSchema,
      outcome: z.literal("rejected"),
      code: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
    })
    .strict(),
]);

export const eventStoreWorkerMessageSchema = z.union([
  z
    .object({ kind: z.literal("open"), requestId: requestIdSchema, workerIndex: workerIndexSchema })
    .strict(),
  z
    .object({
      kind: z.literal("head"),
      requestId: requestIdSchema,
      workerIndex: workerIndexSchema,
      runId: Id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("append"),
      requestId: requestIdSchema,
      workerIndex: workerIndexSchema,
      runId: Id,
      expectedSeq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      workerIndex: workerIndexSchema,
      expectedSeq: z.number().int().nonnegative(),
    })
    .strict(),
  workerResultSchema,
]);

export const workerResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      kind: z.literal("response"),
      requestId: requestIdSchema,
      ok: z.literal(true),
      value: workerResponseValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("response"),
      requestId: requestIdSchema,
      ok: z.literal(false),
      code: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
    })
    .strict(),
]);

/** A validated worker request handled by the adapter connection host. */
export type WorkerRequest = Extract<
  z.infer<typeof eventStoreWorkerMessageSchema>,
  { kind: "open" | "head" | "append" }
>;
/** A validated worker race outcome returned to the conformance suite. */
export type WorkerResult = z.infer<typeof workerResultSchema>;
