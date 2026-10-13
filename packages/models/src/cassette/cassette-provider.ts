// SPDX-License-Identifier: Apache-2.0
import { HarnessError, Sha256Hex, type ModelRequest, type Code } from "@harness/schemas";
import { z } from "zod";
import {
  ProviderResultSchema,
  type ProviderAdapter,
  type ProviderContext,
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
  ) {
    this.mode = CassetteModeSchema.parse(mode);
    if (this.mode === "auto" && process.env.HARNESS_CASSETTE_AUTO === "0") {
      throw new CassetteAutoDisabledError();
    }
  }

  /** {@inheritDoc ProviderAdapter.complete} */
  async complete(request: ModelRequest, context: ProviderContext): Promise<ProviderResult> {
    const hash = requestHash(request);
    if (this.mode !== "record") {
      const response = await this.store.get(hash, request);
      if (response !== undefined) {
        return ProviderResultSchema.parse(response);
      }
      if (this.mode === "replay") {
        throw new CassetteMissError(hash);
      }
    }

    if (this.inner === undefined) {
      throw new CassetteInnerRequiredError();
    }
    const response = ProviderResultSchema.parse(await this.inner.complete(request, context));
    await this.store.set({ hash, response });
    return response;
  }
}
