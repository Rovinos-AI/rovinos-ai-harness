// SPDX-License-Identifier: Apache-2.0
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const endpoint = new URL("http://otel-collector:13133/");

async function isHealthy() {
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitForCollector() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isHealthy()) {
      return true;
    }
    await setTimeout(250);
  }
  return false;
}

async function main() {
  if (process.argv[2] === "--check") {
    process.exitCode = (await isHealthy()) ? 0 : 1;
    return;
  }
  if (!(await waitForCollector())) {
    process.exitCode = 1;
    return;
  }
  while (true) {
    await setTimeout(60_000);
  }
}

const scriptPath = process.argv[1];
if (scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href) {
  await main();
}
