// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Rejects an archived report tree containing any supplied credential canary. */
export async function assertNoCredentialCanaries(
  directory: string,
  canaries: readonly string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoCredentialCanaries(path, canaries);
    } else if (entry.isFile()) {
      const contents = await readFile(path, "utf8");
      if (canaries.some((canary) => contents.includes(canary))) {
        throw new Error("mcp_conformance_report_exposed_credential");
      }
    }
  }
}
