// SPDX-License-Identifier: Apache-2.0
import { aesGcmDecrypt, aesGcmEncrypt } from "@rovinos/crypto";
import {
  ContractError,
  KEY_PROVIDER_KEY_BYTES,
  parseJson,
  type KeyProvider,
} from "@rovinos/schemas";
import { z } from "zod";
import {
  ContentDecryptFailedError,
  ContentEncryptFailedError,
  KeyNotFoundError,
} from "./errors.js";
import {
  MAX_CONTENT_BYTES,
  type ContentCodec,
  type ContentCodecContext,
  type EncodedContent,
} from "./codec.js";
import { JsonContentCodec } from "./codec.js";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const contentSchema = z.record(z.string(), z.json());
const jsonCodec = new JsonContentCodec();

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function additionalData(context: ContentCodecContext): Buffer {
  const identity =
    context.purpose === "snapshot"
      ? `${context.runId}:snap:${context.seq.toString()}`
      : `${context.runId}:${context.seq.toString()}`;
  return Buffer.from(identity, "utf8");
}

function decodeBlob(blob: string): Buffer {
  const decoded = Buffer.from(blob, "base64");
  if (decoded.length < IV_LENGTH + AUTH_TAG_LENGTH || decoded.toString("base64") !== blob) {
    throw new ContentDecryptFailedError();
  }
  return decoded;
}

/** Encrypts content with AES-256-GCM and binds each blob to its event or snapshot. */
export class AesGcmContentCodec implements ContentCodec {
  /** Identifies this codec as encrypted for store metadata checks. */
  readonly encrypted = true;

  /** Create an AES-256-GCM codec backed by the supplied key provider. */
  constructor(private readonly keyProvider: KeyProvider) {}

  /** {@inheritDoc ContentCodec.encode} */
  async encode(
    context: ContentCodecContext,
    content: Record<string, unknown>,
    targetKeyId?: string,
  ): Promise<EncodedContent> {
    let keyId: string;
    try {
      keyId = targetKeyId ?? this.keyProvider.currentKeyId();
    } catch {
      throw new ContentEncryptFailedError();
    }
    const key = await this.loadKey(keyId, false);
    let plaintext: Buffer | undefined;
    try {
      const encoded = await jsonCodec.encode(context, content);
      plaintext = Buffer.from(encoded.blob, "utf8");
      const encrypted = aesGcmEncrypt(key, plaintext, additionalData(context));
      const blob = Buffer.from(encrypted).toString("base64");
      return { blob, keyId };
    } catch (error) {
      if (error instanceof ContractError) {
        throw error;
      }
      throw new ContentEncryptFailedError();
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }

  /** {@inheritDoc ContentCodec.decode} */
  async decode(
    context: ContentCodecContext,
    blob: string,
    keyId?: string,
  ): Promise<Record<string, unknown>> {
    if (keyId === undefined) {
      throw new ContentDecryptFailedError();
    }
    const key = await this.loadKey(keyId, true);
    let plaintext: Uint8Array | undefined;
    try {
      const encoded = decodeBlob(blob);
      plaintext = aesGcmDecrypt(key, encoded, additionalData(context));
      return parseJson(contentSchema, new TextDecoder().decode(plaintext), {
        maxBytes: MAX_CONTENT_BYTES,
      });
    } catch {
      throw new ContentDecryptFailedError();
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }

  private async loadKey(keyId: string, decrypting: boolean): Promise<Buffer> {
    let rawKey: Uint8Array;
    try {
      rawKey = await this.keyProvider.getKey(keyId);
    } catch (error) {
      if (errorCode(error) === "key_not_found" || error instanceof KeyNotFoundError) {
        throw new KeyNotFoundError();
      }
      if (decrypting) {
        throw new ContentDecryptFailedError();
      }
      throw new ContentEncryptFailedError();
    }
    if (!(rawKey instanceof Uint8Array) || rawKey.byteLength !== KEY_PROVIDER_KEY_BYTES) {
      if (decrypting) {
        throw new ContentDecryptFailedError();
      }
      throw new ContentEncryptFailedError();
    }
    return Buffer.from(rawKey);
  }
}
