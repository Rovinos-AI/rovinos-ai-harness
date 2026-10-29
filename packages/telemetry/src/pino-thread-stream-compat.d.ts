// SPDX-License-Identifier: Apache-2.0
declare module "worker_threads" {
  export type TransferListItem = import("node:worker_threads").Transferable;
}
