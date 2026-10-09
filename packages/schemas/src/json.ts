// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** TODO task 14.2: tighten model message and content payload types. */
export const JsonValue = z.json();

/** Inferred recursive JSON value type. */
export type JsonValue = z.infer<typeof JsonValue>;
