// SPDX-License-Identifier: Apache-2.0
import type { JsonValue } from "@harness/schemas";
import { PiiTokenizerError } from "./errors.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Reject JSON whose UTF-8 serialized size exceeds the tokenizer limit. */
export function assertJsonSize(value: JsonValue): void {
  new JsonSizeTracker().addValue(value);
}

class JsonSizeTracker {
  private bytes = 0;
  private stringUnits = 0;

  addValue(value: JsonValue): void {
    if (typeof value === "string") {
      this.addString(value);
    } else if (value === null) {
      this.addBytes(4);
    } else if (typeof value === "boolean") {
      this.addBytes(value ? 4 : 5);
    } else if (typeof value === "number") {
      this.addBytes(JSON.stringify(value).length);
    } else if (Array.isArray(value)) {
      this.addBytes(2);
      value.forEach((child, index) => {
        if (index > 0) {
          this.addBytes(1);
        }
        this.addValue(child);
      });
    } else {
      const entries = Object.entries(value);
      this.addBytes(2);
      entries.forEach(([key, child], index) => {
        if (index > 0) {
          this.addBytes(1);
        }
        this.addString(key);
        this.addBytes(1);
        this.addValue(child);
      });
    }
  }

  private addString(value: string): void {
    if (value.length > MAX_JSON_BYTES - this.stringUnits) {
      throw new PiiTokenizerError("pii_input_too_large");
    }
    this.stringUnits += value.length;
    this.addBytes(new TextEncoder().encode(JSON.stringify(value)).byteLength);
  }

  private addBytes(bytes: number): void {
    if (bytes > MAX_JSON_BYTES - this.bytes) {
      throw new PiiTokenizerError("pii_input_too_large");
    }
    this.bytes += bytes;
  }
}
