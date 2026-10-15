// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { JsonValue } from "./json.js";
import { Code, Id } from "./primitives.js";

/** Sanitized app content recorded with its host-bound identity and trust label. */
export const AppContentEnvelopeSchema = z
  .object({
    kind: z.enum(["message", "model_context"]),
    source: z.literal("app"),
    label: z.literal("App-provided"),
    appId: Code,
    runId: Id,
    content: JsonValue,
  })
  .strict();

/** Inferred tokenized app content envelope. */
export type AppContentEnvelope = z.infer<typeof AppContentEnvelopeSchema>;
