// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** Validates a 26-character ULID. */
export const Id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

/** Inferred ULID type. */
export type Id = z.infer<typeof Id>;

/** Validates a bounded lowercase code. */
export const Code = z.string().regex(/^[a-z0-9_.-]{1,64}$/u);

/** Inferred code type. */
export type Code = z.infer<typeof Code>;

/** Validates a lowercase SHA-256 hex digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

/** Inferred SHA-256 digest type. */
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** Validates a lowercase 32-character trace identifier. */
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/u);

/** Inferred trace identifier type. */
export type TraceId = z.infer<typeof TraceId>;

/** Validates a lowercase 16-character span identifier. */
export const SpanId = z.string().regex(/^[0-9a-f]{16}$/u);

/** Inferred span identifier type. */
export type SpanId = z.infer<typeof SpanId>;

/** Validates a W3C version 00 traceparent value. */
export const Traceparent = z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u);

/** Inferred W3C traceparent type. */
export type Traceparent = z.infer<typeof Traceparent>;

/** Validates a bounded workspace reference. */
export const WorkspaceRef = z.string().regex(/^[\w:./-]{1,128}$/u);

/** Inferred workspace reference type. */
export type WorkspaceRef = z.infer<typeof WorkspaceRef>;
