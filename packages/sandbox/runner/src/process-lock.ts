// SPDX-License-Identifier: Apache-2.0

let pendingOperations: Promise<void> = Promise.resolve();

/** Serializes operations that may observe or change process-wide runner credentials. */
export function withRunnerProcessLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingOperations.then(operation);
  pendingOperations = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
