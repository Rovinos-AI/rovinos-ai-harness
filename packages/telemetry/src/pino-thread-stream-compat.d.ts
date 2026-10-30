// SPDX-License-Identifier: Apache-2.0
import type { Transferable } from "node:worker_threads";

declare module "worker_threads" {
  /** Compatibility alias required by thread-stream 4.2 with Node 26 types. */
  export type TransferListItem = Transferable;
}
