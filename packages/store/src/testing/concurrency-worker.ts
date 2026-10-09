// SPDX-License-Identifier: Apache-2.0
/** Source executed by each resume-race worker thread. */
export const concurrencyWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
let requestId = 0;
const pending = new Map();
let releaseStart;
const start = new Promise((resolve) => {
  releaseStart = resolve;
});

parentPort.on("message", (message) => {
  if (message.kind === "start") {
    releaseStart();
    return;
  }
  if (message.kind !== "response") {
    return;
  }
  const waiting = pending.get(message.requestId);
  if (waiting === undefined) {
    return;
  }
  pending.delete(message.requestId);
  if (message.ok) {
    waiting.resolve(message.value);
  } else {
    waiting.reject({ code: message.code });
  }
});

function request(kind, values = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ kind, requestId: id, workerIndex: workerData.workerIndex, ...values });
  });
}

function errorCode(error) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") {
      return code;
    }
  }
  return "store_error";
}

(async () => {
  try {
    await request("open");
    const runId = workerData.runId;
    const expectedSeq = await request("head", { runId });
    parentPort.postMessage({ kind: "ready", workerIndex: workerData.workerIndex, expectedSeq });
    await start;
    const result = await request("append", { runId, expectedSeq });
    parentPort.postMessage({
      kind: "result",
      workerIndex: workerData.workerIndex,
      outcome: "fulfilled",
      nextSeq: result.nextSeq,
    });
  } catch (error) {
    parentPort.postMessage({
      kind: "result",
      workerIndex: workerData.workerIndex,
      outcome: "rejected",
      code: errorCode(error),
    });
  } finally {
    parentPort.close();
  }
})();
`;
