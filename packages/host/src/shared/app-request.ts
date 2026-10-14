// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Minimal result returned by the host's gated app-request endpoint. */
export const AppRequestResultSchema = z.object({ allowed: z.boolean() }).strict();

/** Inferred result for the host's gated app-request endpoint. */
export type AppRequestResult = z.infer<typeof AppRequestResultSchema>;
