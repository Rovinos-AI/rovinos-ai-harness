// SPDX-License-Identifier: Apache-2.0
import { ContractError, parseJson } from "@harness/schemas";
import type { Id } from "@harness/schemas";
import { z } from "zod";

const contentSchema = z.record(z.string(), z.json());

/** Context binding a content encoding to its event. */
export interface ContentCodecContext {
  /** Event's run identifier. */
  runId: Id;
  /** Event's sequence number. */
  seq: number;
}

/** Encoded event content and optional encryption key identifier. */
export interface EncodedContent {
  /** Serialized or encrypted content blob. */
  blob: string;
  /** Key identifier used for encryption, when applicable. */
  keyId?: string;
}

/** Encodes and decodes event content independently of event metadata. */
export interface ContentCodec {
  /**
   * Encode content for an event.
   *
   * @param ctx Event identity used by contextual codecs.
   * @param content Content-classified event fields.
   * @returns The encoded blob and optional key identifier.
   */
  encode(ctx: ContentCodecContext, content: Record<string, unknown>): Promise<EncodedContent>;
  /**
   * Decode content for an event.
   *
   * @param ctx Event identity used by contextual codecs.
   * @param blob Encoded content blob.
   * @param keyId Optional key identifier from storage.
   * @returns Content-classified event fields.
   */
  decode(ctx: ContentCodecContext, blob: string, keyId?: string): Promise<Record<string, unknown>>;
}

/** JSON serialization codec for event content when encryption is not configured. */
export class JsonContentCodec implements ContentCodec {
  /** {@inheritDoc ContentCodec.encode} */
  encode(_ctx: ContentCodecContext, content: Record<string, unknown>): Promise<EncodedContent> {
    return Promise.resolve().then(() => {
      let blob: unknown;
      try {
        blob = JSON.stringify(content);
      } catch {
        throw new ContractError([{ path: [], code: "json_encode_failed" }]);
      }
      if (typeof blob !== "string") {
        throw new ContractError([{ path: [], code: "json_encode_failed" }]);
      }
      return { blob };
    });
  }

  /** {@inheritDoc ContentCodec.decode} */
  decode(
    _ctx: ContentCodecContext,
    blob: string,
    _keyId?: string,
  ): Promise<Record<string, unknown>> {
    return Promise.resolve().then(() => parseJson(contentSchema, blob));
  }
}
