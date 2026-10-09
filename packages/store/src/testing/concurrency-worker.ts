// SPDX-License-Identifier: Apache-2.0
/** Source executed by each resume-race worker thread. */
export const concurrencyWorkerSource = `
const { parentPort, threadId, workerData } = require("node:worker_threads");
let store;
let activeIteration;
let releaseStart;

parentPort.on("message", (message) => {
  if (message.kind === "start" && message.iteration === activeIteration) {
    releaseStart();
  } else if (message.kind === "run") {
    void run(message);
  }
});

function errorCode(error) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[a-z0-9_.-]{1,64}$/.test(code)) {
      return code;
    }
  }
  return "store_error";
}

async function run(message) {
  activeIteration = message.iteration;
  try {
    const expectedSeq = await store.head(message.runId);
    const start = new Promise((resolve) => {
      releaseStart = resolve;
    });
    parentPort.postMessage({
      kind: "ready",
      iteration: message.iteration,
      workerIndex: workerData.workerIndex,
      expectedSeq,
      threadId,
    });
    await start;
    const result = await store.append(message.runId, [message.event], expectedSeq);
    parentPort.postMessage({
      kind: "result",
      iteration: message.iteration,
      workerIndex: workerData.workerIndex,
      threadId,
      outcome: "fulfilled",
      nextSeq: result.nextSeq,
    });
  } catch (error) {
    parentPort.postMessage({
      kind: "result",
      iteration: message.iteration,
      workerIndex: workerData.workerIndex,
      threadId,
      outcome: "rejected",
      code: errorCode(error),
    });
  } finally {
    activeIteration = undefined;
  }
}

(async () => {
  try {
    const workerModule = await import(workerData.worker.module);
    const openStore = workerModule[workerData.worker.exportName];
    if (typeof openStore !== "function") {
      throw new Error("Worker event-store opener is missing");
    }
    store = await openStore(workerData.worker.args);
    parentPort.postMessage({
      kind: "opened",
      workerIndex: workerData.workerIndex,
      threadId,
    });
  } catch (error) {
    parentPort.postMessage({ kind: "open_error", workerIndex: workerData.workerIndex, code: errorCode(error) });
  }
})();
`;
