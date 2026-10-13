// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseJson,
  Sha256Hex,
  type ModelRequest,
  type Sha256Hex as Sha256HexType,
} from "@harness/schemas";
import { z } from "zod";
import { CassetteEntrySchema, type CassetteEntry, type CassetteStore } from "./cassette-provider.js";

/** Strict, privacy-declared file format for a cassette scenario. */
export const CassetteFileSchema = z
  .object({
    containsRealData: z.literal(false),
    entries: z.array(CassetteEntrySchema),
  })
  .strict();

/** Inferred cassette file. */
export type CassetteFile = z.infer<typeof CassetteFileSchema>;

function isMissingFile(error: unknown): boolean {
  return z.object({ code: z.literal("ENOENT") }).passthrough().safeParse(error).success;
}

function stableFile(entries: ReadonlyMap<string, CassetteEntry>): string {
  const sortedEntries = [...entries.values()].sort((left, right) =>
    left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0,
  );
  const cassetteFile: CassetteFile = { containsRealData: false, entries: sortedEntries };
  return `${JSON.stringify(cassetteFile, null, 2)}\n`;
}

/** File-backed cassette store with deterministic ordering and formatting. */
export class FileCassetteStore implements CassetteStore {
  private entries = new Map<string, CassetteEntry>();
  private initialization: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  /**
   * @param filePath - JSON file dedicated to a single replay scenario.
   */
  constructor(private readonly filePath: string) {}

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const cassetteFile = parseJson(CassetteFileSchema, text);
      this.entries = new Map(cassetteFile.entries.map((entry) => [entry.hash, entry]));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      this.entries = new Map();
    }
  }

  private async ready(): Promise<Map<string, CassetteEntry>> {
    this.initialization ??= this.load();
    await this.initialization;
    return this.entries;
  }

  /** @inheritdoc CassetteStore */
  async get(
    hash: Sha256HexType,
    _request: ModelRequest,
  ): Promise<CassetteEntry["response"] | undefined> {
    const entries = await this.ready();
    const entry = entries.get(Sha256Hex.parse(hash));
    return entry?.response;
  }

  /** @inheritdoc CassetteStore */
  async set(entry: CassetteEntry): Promise<void> {
    const validEntry = CassetteEntrySchema.parse(entry);
    const entries = await this.ready();
    entries.set(validEntry.hash, validEntry);
    const write = this.writeTail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, stableFile(entries), "utf8");
    });
    this.writeTail = write.catch(() => undefined);
    await write;
  }
}
