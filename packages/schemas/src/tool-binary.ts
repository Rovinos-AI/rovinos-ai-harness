// SPDX-License-Identifier: Apache-2.0
// Task 13.7: only numeric bytes, never text or metadata, qualify for a binary bypass.
import { z } from "zod";

/** Binary tool payload represented as JSON-compatible unsigned bytes. */
export const ToolBinaryPayloadSchema = z.array(z.number().int().min(0).max(255));

/** Validated JSON-compatible binary payload. */
export type ToolBinaryPayload = z.infer<typeof ToolBinaryPayloadSchema>;
