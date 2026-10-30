// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const AnswerSchema = z.object({ answer: z.string() }).strict();
export const TokenizedAnswerSchema = z.object({ email: z.email() }).strict();
export const ThrowingSchema = z.string().transform(() => {
  throw new Error("synthetic validation failure");
});
