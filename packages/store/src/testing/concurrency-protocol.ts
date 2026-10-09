// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const workerIndexSchema = z.union([z.literal(0), z.literal(1)]);
const iterationSchema = z.number().int().nonnegative();
const threadIdSchema = z.number().int().positive();

export const workerReadySchema = z
  .object({
    kind: z.literal("ready"),
    iteration: iterationSchema,
    workerIndex: workerIndexSchema,
    expectedSeq: z.number().int().nonnegative(),
    threadId: threadIdSchema,
  })
  .strict();

export const workerResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      kind: z.literal("result"),
      iteration: iterationSchema,
      workerIndex: workerIndexSchema,
      threadId: threadIdSchema,
      outcome: z.literal("fulfilled"),
      nextSeq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      iteration: iterationSchema,
      workerIndex: workerIndexSchema,
      threadId: threadIdSchema,
      outcome: z.literal("rejected"),
      code: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
    })
    .strict(),
]);

export const eventStoreWorkerMessageSchema = z.union([
  z
    .object({
      kind: z.literal("opened"),
      workerIndex: workerIndexSchema,
      threadId: threadIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("open_error"),
      workerIndex: workerIndexSchema,
      code: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
    })
    .strict(),
  workerReadySchema,
  workerResultSchema,
]);

/** Validated worker head observed before releasing a resume attempt. */
export type WorkerReady = z.infer<typeof workerReadySchema>;
/** Validated outcome of a worker resume attempt. */
export type WorkerResult = z.infer<typeof workerResultSchema>;
