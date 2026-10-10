// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Strict JSON value schema for provider-neutral data. */
export const JsonValue = z.json();

/** Inferred recursive JSON value type. */
export type JsonValue = z.infer<typeof JsonValue>;
