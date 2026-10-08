// SPDX-License-Identifier: Apache-2.0
/** Writes the version output to stdout. */
export function writeOutput(output: string): void {
  process.stdout.write(output);
}
