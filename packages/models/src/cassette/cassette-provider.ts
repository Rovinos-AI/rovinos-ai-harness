// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Sha256Hex, type ModelRequest, type Code } from "@rovinos/schemas";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import {
  assembleDeltas,
  ProviderDeltaSchema,
  ProviderResultSchema,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDelta,
  type ProviderResult,
} from "../types.js";
import { requestHash } from "./hash.js";

/** Supported cassette modes. */
export const CassetteModeSchema = z.enum(["record", "replay", "auto"]);

/** Inferred cassette mode. */
export type CassetteMode = z.infer<typeof CassetteModeSchema>;

/** A response indexed by its stable request hash. */
export const CassetteEntrySchema = z
  .object({
    hash: Sha256Hex,
    response: ProviderResultSchema,
  })
  .strict();

/** Inferred cassette entry. */
export type CassetteEntry = z.infer<typeof CassetteEntrySchema>;

/** Storage contract used by cassette adapters. */
export interface CassetteStore {
  /** Finds a recorded response for a request hash. */
  get(hash: z.infer<typeof Sha256Hex>, request: ModelRequest): Promise<ProviderResult | undefined>;
  /** Persists a response for a request hash. */
  set(entry: CassetteEntry): Promise<void>;
}

/** Hooks used to tokenize and verify a response before it is persisted. */
export interface CassettePrivacyOptions {
  /** Applies storage-boundary tokenization to a provider response. */
  readonly sanitize: (response: ProviderResult) => Promise<ProviderResult>;
  /** Returns whether a detector still finds sensitive content in a response. */
  readonly detectRealData: (response: ProviderResult) => Promise<boolean>;
}

/** Optional cassette runtime dependencies. */
export interface CassetteProviderOptions extends Partial<CassettePrivacyOptions> {
  /** Environment values used by the auto-mode guard. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function resultDeltas(result: ProviderResult): ProviderDelta[] {
  const deltas: ProviderDelta[] = [];
  let index = 0;
  for (const part of result.parts) {
    if (part.type === "text") {
      deltas.push({ type: "text", index, text: part.text });
      index += 1;
    } else if (part.type === "tool_call") {
      deltas.push({
        type: "tool_call",
        index,
        callId: part.callId,
        toolId: part.toolId,
        arguments: JSON.stringify(part.args),
      });
      index += 1;
    } else if (part.type === "opaque") {
      deltas.push({ type: "opaque", part });
    } else {
      throw new ProviderError("provider_unknown");
    }
  }
  deltas.push(
    { type: "usage", usage: result.usage },
    { type: "finish", finishReason: result.finishReason, latencyMs: result.latencyMs },
  );
  return deltas;
}

async function* withActivityHeartbeat<T>(
  operation: Promise<T>,
  idleTimeoutMs: number | undefined,
): AsyncGenerator<ProviderDelta, T> {
  if (idleTimeoutMs === undefined) {
    return operation;
  }
  const completion = operation.then(
    (value) => ({ type: "success" as const, value }),
    (error: unknown) => ({ type: "failure" as const, error }),
  );
  const intervalMs = Math.max(1, Math.floor(idleTimeoutMs / 2));
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: Awaited<typeof completion> | { readonly type: "heartbeat" };
    try {
      outcome = await Promise.race([
        completion,
        new Promise<{ readonly type: "heartbeat" }>((resolve) => {
          timer = setTimeout(() => {
            resolve({ type: "heartbeat" });
          }, intervalMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    if (outcome.type === "heartbeat") {
      yield { type: "activity" };
    } else if (outcome.type === "failure") {
      throw outcome.error;
    } else {
      return outcome.value;
    }
  }
}

/** Raised when a request has no recorded cassette response. */
export class CassetteMissError extends HarnessError {
  readonly code = "cassette_miss";

  /** Stable hash for the missing request. */
  readonly hash: z.infer<typeof Sha256Hex>;

  /** @param hash - Hash of the request with no cassette entry. */
  constructor(hash: z.infer<typeof Sha256Hex>) {
    super("No cassette response exists for this request.");
    this.hash = hash;
  }
}

/** Raised when a sanitized cassette response still contains detected real data. */
export class CassetteRealDataDetectedError extends HarnessError {
  readonly code = "cassette_real_data_detected";

  /** Creates the content-free unsafe-cassette error. */
  constructor() {
    super("A cassette response contains detected real data.");
  }
}

/** Raised when recording is requested without privacy hooks. */
export class CassettePrivacyRequiredError extends HarnessError {
  readonly code = "cassette_privacy_required";

  /** Creates the missing-privacy-hooks error. */
  constructor() {
    super("Recording requires cassette sanitization and detection hooks.");
  }
}

/** Raised when an event-log replay request differs from the recorded request. */
export class CassetteDivergenceError extends HarnessError {
  readonly code = "cassette_divergence";

  /** Hash recorded in the event log. */
  readonly expectedHash: z.infer<typeof Sha256Hex>;
  /** Hash of the incoming request fields available in the event log. */
  readonly actualHash: z.infer<typeof Sha256Hex>;

  /**
   * @param expectedHash - Stable hash for the recorded request.
   * @param actualHash - Stable hash for the incoming request.
   */
  constructor(expectedHash: z.infer<typeof Sha256Hex>, actualHash: z.infer<typeof Sha256Hex>) {
    super("The replay request diverges from the recorded request.");
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/** Raised when an event log cannot be paired into complete model calls. */
export class CassetteLogIncompleteError extends HarnessError {
  readonly code = "cassette_log_incomplete";

  /** Creates the content-free incomplete-log error. */
  constructor() {
    super("The cassette event log contains an incomplete model call.");
  }
}

/** Raised when auto mode is disabled by the runtime environment. */
export class CassetteAutoDisabledError extends HarnessError {
  readonly code = "cassette_auto_disabled";

  /** Creates the auto-mode-disabled error. */
  constructor() {
    super("Cassette auto mode is disabled.");
  }
}

/** Raised when recording is requested without a provider adapter. */
export class CassetteInnerRequiredError extends HarnessError {
  readonly code = "cassette_inner_required";

  /** Creates the missing-inner-adapter error. */
  constructor() {
    super("Recording requires an inner provider adapter.");
  }
}

/** Raised when a write is attempted against an event-log cassette store. */
export class CassetteStoreReadOnlyError extends HarnessError {
  readonly code = "cassette_store_read_only";

  /** Creates the read-only-store error. */
  constructor() {
    super("The event-log cassette store is read-only.");
  }
}

/** Provider adapter that records live responses and replays stored ones. */
export class CassetteProvider implements ProviderAdapter {
  readonly provider: Code = "cassette";
  readonly kind = "cassette" as const;
  private readonly mode: CassetteMode;

  /**
   * @param mode - Record, replay, or replay-first mode.
   * @param store - Cassette store used for lookup and recording.
   * @param inner - Live provider adapter required when a response must be recorded.
   */
  constructor(
    mode: CassetteMode,
    private readonly store: CassetteStore,
    private readonly inner?: ProviderAdapter,
    private readonly options: CassetteProviderOptions = {},
  ) {
    this.mode = CassetteModeSchema.parse(mode);
    if (
      this.mode !== "replay" &&
      (options.sanitize === undefined || options.detectRealData === undefined)
    ) {
      throw new CassettePrivacyRequiredError();
    }
    if (this.mode === "auto" && (options.env ?? process.env).HARNESS_CASSETTE_AUTO === "0") {
      throw new CassetteAutoDisabledError();
    }
  }

  /** {@inheritDoc ProviderAdapter.complete} */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const hash = requestHash(request);
    if (this.mode !== "record") {
      const response = await this.store.get(hash, request);
      if (response !== undefined) {
        return response;
      }
      if (this.mode === "replay") {
        throw new CassetteMissError(hash);
      }
    }

    if (this.inner === undefined) {
      throw new CassetteInnerRequiredError();
    }
    const response = ProviderResultSchema.parse(await this.inner.complete(request, context));
    const sanitized = await this.prepareForStorage(response);
    await this.store.set({ hash, response: sanitized });
    return sanitized;
  }

  /** @inheritdoc */
  async *stream(request: ModelRequest, context: ProviderContext): AsyncIterable<ProviderDelta> {
    const hash = requestHash(request);
    if (this.mode !== "record") {
      const response = await this.store.get(hash, request);
      if (response !== undefined) {
        yield* resultDeltas(response);
        return;
      }
      if (this.mode === "replay") {
        throw new CassetteMissError(hash);
      }
    }

    if (this.inner === undefined) {
      throw new CassetteInnerRequiredError();
    }
    let response: ProviderResult;
    if (this.inner.stream === undefined) {
      response = ProviderResultSchema.parse(await this.inner.complete(request, context));
    } else {
      const deltas: ProviderDelta[] = [];
      for await (const delta of this.inner.stream(request, context)) {
        const parsed = ProviderDeltaSchema.parse(delta);
        deltas.push(parsed);
        yield parsed.type === "usage" ? parsed : { type: "activity" };
      }
      response = assembleDeltas(deltas);
    }
    const sanitized = yield* withActivityHeartbeat(
      (async () => {
        const value = await this.prepareForStorage(response);
        await this.store.set({ hash, response: value });
        return value;
      })(),
      context.idleTimeoutMs,
    );
    yield* resultDeltas(sanitized);
  }

  private async prepareForStorage(response: ProviderResult): Promise<ProviderResult> {
    const sanitize = this.options.sanitize;
    const detectRealData = this.options.detectRealData;
    if (sanitize === undefined || detectRealData === undefined) {
      throw new CassettePrivacyRequiredError();
    }
    const sanitized = ProviderResultSchema.parse(await sanitize(response));
    let detected: boolean;
    try {
      detected = await detectRealData(sanitized);
    } catch {
      throw new CassetteRealDataDetectedError();
    }
    if (detected) {
      throw new CassetteRealDataDetectedError();
    }
    return sanitized;
  }
}
